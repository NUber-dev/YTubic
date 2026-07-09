import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import type { ShelfItem, Thumbnail } from "./types";

export type YtNode = Record<string, any>;

const WEB_REMIX_CLIENT_VERSION = "1.20260510.02.00";

const VISITOR_DATA_STORAGE_KEY = "ytm-visitor-data";

// Module-level cache of the YTM visitor data token. Bootstrapped lazily from
// localStorage on first read, refreshed on every response that includes one
// in `responseContext.visitorData`. Persisted so cold-start lyrics calls have
// it on the very first request — otherwise YTM treats us as a fresh visitor
// and serves a degraded experience (notably: no synced lyrics even for
// Premium accounts).
let cachedVisitorData: string | null | undefined = undefined;

function loadVisitorData(): string | null {
  if (cachedVisitorData !== undefined) return cachedVisitorData;
  try {
    cachedVisitorData = window.localStorage.getItem(VISITOR_DATA_STORAGE_KEY);
  } catch {
    cachedVisitorData = null;
  }
  return cachedVisitorData;
}

function saveVisitorData(value: string): void {
  if (cachedVisitorData === value) return;
  cachedVisitorData = value;
  try {
    window.localStorage.setItem(VISITOR_DATA_STORAGE_KEY, value);
  } catch {
    /* private mode etc — keep the in-memory copy */
  }
}

/**
 * Walk an innertube response for `responseContext.visitorData` and update
 * our cache when present. Called from every `innertubePost` so the next
 * request can echo it back in `context.client.visitorData`.
 */
function captureVisitorData(response: YtNode): void {
  const vd = response?.responseContext?.visitorData;
  if (typeof vd === "string" && vd.length > 0) saveVisitorData(vd);
}

function buildContext(): {
  client: Record<string, unknown>;
  user: unknown;
  request: unknown;
} {
  const client: Record<string, unknown> = {
    clientName: "WEB_REMIX",
    clientVersion: WEB_REMIX_CLIENT_VERSION,
    hl: "en",
    gl: "US",
    platform: "DESKTOP",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36,gzip(gfe)",
    originalUrl: "https://music.youtube.com/",
  };
  const visitor = loadVisitorData();
  if (visitor) client.visitorData = visitor;
  return {
    client,
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
  };
}

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": DESKTOP_UA,
  "X-YouTube-Client-Name": "67",
  "X-YouTube-Client-Version": WEB_REMIX_CLIENT_VERSION,
  Origin: "https://music.youtube.com",
  Referer: "https://music.youtube.com/",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Origin": "https://music.youtube.com",
  "X-Goog-AuthUser": "0",
};

const YTM_ORIGIN = "https://music.youtube.com";

async function sha1Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Cookie header plus the active brand-channel page id, as one unit.
 * They describe the same identity, so caching them separately could
 * pair fresh cookies with a stale channel (or vice versa) across a
 * sign-in or a channel switch.
 */
type AuthContext = { cookie: string; pageId: string | null };

const EMPTY_AUTH: AuthContext = { cookie: "", pageId: null };

// In-process cache for the auth context. Without it every browse / search
// / next call invokes the Rust side, which hits disk + DPAPI-decrypts the
// jar (a 1000-track playlist scroll would do that 10+ times for no gain).
// TTL keeps us responsive to silent re-logins (different webview session
// dropping a fresh SID); `resetAuthCache()` is the explicit invalidation
// path called from `resetInnertube()` after sign-in / sign-out.
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
let authCache: { value: AuthContext; loadedAt: number } | null = null;
let authPromise: Promise<AuthContext> | null = null;
// Bumped by resetAuthCache(). An in-flight load captures the epoch at start
// and discards its result if a reset happened meanwhile; otherwise the
// pre-reset value would be written back and served for the whole TTL after
// a sign-in/out completes mid-fetch.
let authEpoch = 0;

async function loadAuthContext(): Promise<AuthContext> {
  const now = Date.now();
  if (authCache && now - authCache.loadedAt < AUTH_CACHE_TTL_MS) {
    return authCache.value;
  }
  if (authPromise) return authPromise;
  const epoch = authEpoch;
  authPromise = invoke<AuthContext>("get_auth_context", {
    host: "music.youtube.com",
  }).then(
    (value) => {
      authPromise = null;
      if (epoch !== authEpoch) return EMPTY_AUTH;
      authCache = { value, loadedAt: Date.now() };
      return value;
    },
    () => {
      authPromise = null;
      if (epoch !== authEpoch) return EMPTY_AUTH;
      authCache = { value: EMPTY_AUTH, loadedAt: Date.now() };
      return EMPTY_AUTH;
    },
  );
  return authPromise;
}

/**
 * Drop the cached cookie header. Call from `resetInnertube()` after a
 * sign-in / sign-out so the next request re-reads the fresh jar.
 */
export function resetAuthCache(): void {
  authCache = null;
  authPromise = null;
  authEpoch++;
}

/**
 * Split a combined `set-cookie` header into individual cookies. Only
 * used when `Headers.getSetCookie` is unavailable. Commas inside
 * Expires dates ("Tue, 07 Jul 2027 ...") are followed by a space and a
 * bare token, never by `name=`, so splitting on a comma followed by a
 * cookie-name prefix is safe for the values Google sends.
 */
export function splitSetCookieHeader(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Echo `Set-Cookie` headers from a music.youtube.com response back
 * into the active account's encrypted jar (via Rust). Google rotates
 * its session-security cookies (SIDCC / __Secure-*PSIDCC / LOGIN_INFO)
 * right after sign-in and expects the client to send the fresh values
 * from then on; a client that keeps replaying the pre-rotation
 * snapshot matches the stolen-cookie heuristic and the whole session
 * gets revoked within hours — the v0.2.0 "library and Premium vanish"
 * bug. The tauri http plugin deliberately exposes `set-cookie` on
 * response headers, which lets us behave like the browser here.
 *
 * Best-effort by design: a failed merge must never fail the data call
 * that triggered it.
 */
export async function captureSetCookies(res: Response): Promise<void> {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : splitSetCookieHeader(res.headers.get("set-cookie") ?? "");
  if (lines.length === 0) return;
  let host: string;
  try {
    host = new URL(res.url).hostname;
  } catch {
    return;
  }
  try {
    const changed = await invoke<boolean>("merge_response_cookies", {
      host,
      setCookies: lines,
    });
    // A rotated value means the cached Cookie header is stale — drop
    // it so the next request sends what Google just issued.
    if (changed) resetAuthCache();
  } catch (e) {
    console.warn("[auth] failed to merge rotated cookies:", e);
  }
}

/**
 * Build the Cookie + SAPISIDHASH auth headers needed to hit
 * authenticated InnerTube endpoints (/browse FEmusic_liked_*, etc.),
 * plus `X-Goog-PageId` when the account acts as a brand channel
 * (library, likes and home are scoped to the channel, not the Google
 * account). Returns an empty object when the user has no cookies
 * imported; callers fall back to anonymous requests.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { cookie, pageId } = await loadAuthContext();
  if (!cookie) return {};
  const sapisid =
    cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1] ??
    cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1];
  const headers: Record<string, string> = { Cookie: cookie };
  if (pageId) headers["X-Goog-PageId"] = pageId;
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${sapisid} ${YTM_ORIGIN}`);
    headers.Authorization = `SAPISIDHASH ${ts}_${hash}`;
  }
  return headers;
}

export async function innertubePost(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<YtNode> {
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;
  const auth = await authHeaders();
  const visitor = loadVisitorData();
  const visitorHeader: Record<string, string> = visitor
    ? { "X-Goog-Visitor-Id": visitor }
    : {};
  const res = await tauriFetch(url, {
    method: "POST",
    headers: { ...BASE_HEADERS, ...visitorHeader, ...auth },
    body: JSON.stringify({ context: buildContext(), ...body }),
  });

  // Before the error bail: Google rotates cookies on 4xx responses too.
  await captureSetCookies(res);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `InnerTube ${endpoint} → HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as YtNode;
  captureVisitorData(json);
  return json;
}

export function rawBrowse(browseId: string, params?: string): Promise<YtNode> {
  const body: Record<string, unknown> = { browseId };
  if (params) body.params = params;
  return innertubePost("browse", body);
}

export function rawSearch(query: string, params?: string): Promise<YtNode> {
  const body: Record<string, unknown> = { query };
  if (params) body.params = params;
  return innertubePost("search", body);
}

export function rawNext(body: Record<string, unknown>): Promise<YtNode> {
  return innertubePost("next", body);
}

/**
 * Fetch the next page of a long browse response. Accepts either the
 * legacy `nextContinuationData.continuation` token or the modern
 * `continuationCommand.token`.
 */
export function rawBrowseContinuation(token: string): Promise<YtNode> {
  return innertubePost("browse", { continuation: token });
}

/**
 * Walk an InnerTube response for a continuation token. Returns the
 * first one found — playlists typically have a single continuation
 * pointer near the tracks shelf; other tokens (sidebar feeds, etc.)
 * would not yield more track rows anyway.
 */
export function findContinuationToken(root: unknown): string | undefined {
  const seen = new WeakSet<object>();
  let result: string | undefined;
  const walk = (node: unknown): void => {
    if (result) return;
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) {
        if (result) return;
        walk(c);
      }
      return;
    }
    const n = node as YtNode;
    const t1: string | undefined = n.nextContinuationData?.continuation;
    if (t1) {
      result = t1;
      return;
    }
    const t2: string | undefined = n.continuationCommand?.token;
    if (t2) {
      result = t2;
      return;
    }
    for (const key of Object.keys(n)) {
      if (result) return;
      walk(n[key]);
    }
  };
  walk(root);
  return result;
}

/**
 * Map a `playlistPanelVideoRenderer` (the row shape /next returns inside
 * a playlistPanelRenderer — used for radio/autoplay tracks) to our
 * ShelfItem.
 */
export function mapPlaylistPanelVideo(raw: YtNode): ShelfItem | null {
  const videoId: string | undefined =
    raw.navigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;

  const title = readRuns(raw.title);
  const subtitleRuns: YtNode[] =
    raw.longBylineText?.runs ?? raw.shortBylineText?.runs ?? [];

  const artists: { id?: string; name: string }[] = [];
  let album: string | undefined;
  let albumId: string | undefined;
  for (const run of subtitleRuns) {
    const browseId = run.navigationEndpoint?.browseEndpoint?.browseId as
      string | undefined;
    const pageType = run.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
      ?.pageType as string | undefined;
    if (browseId && pageType?.includes("ARTIST")) {
      artists.push({ id: browseId, name: run.text ?? "" });
    } else if (browseId && pageType?.includes("ALBUM")) {
      album = run.text ?? album;
      albumId = browseId;
    }
  }

  const duration = parseDuration(readRuns(raw.lengthText));
  const thumbnails = readThumbnails(raw.thumbnail);
  const explicit = readExplicit(raw);

  return {
    kind: "song",
    id: videoId,
    title,
    subtitle: artists.map((a) => a.name).join(", ") || undefined,
    thumbnails,
    artists: artists.length ? artists : undefined,
    album,
    albumId,
    duration,
    explicit: explicit || undefined,
  };
}

/**
 * Detect the explicit-content badge on a row/card. YTM exposes it under
 * a few different keys depending on the renderer (responsive list rows
 * use `badges`, two-row cards use `subtitleBadges`, panel videos use
 * `badges` too).
 */
export function readExplicit(raw: YtNode): boolean {
  const buckets: YtNode[][] = [raw.badges ?? [], raw.subtitleBadges ?? []];
  for (const bucket of buckets) {
    for (const b of bucket) {
      const r = b.musicInlineBadgeRenderer;
      if (!r) continue;
      const iconType = r.icon?.iconType;
      if (typeof iconType === "string" && iconType.includes("EXPLICIT"))
        return true;
      const label =
        r.accessibilityData?.accessibilityData?.label ?? r.accessibilityText;
      if (typeof label === "string" && /explicit/i.test(label)) return true;
    }
  }
  return false;
}

export function readThumbnails(node: YtNode | undefined): Thumbnail[] {
  if (!node) return [];
  const arr = node.thumbnails ?? node.thumbnail?.thumbnails ?? [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((t: YtNode) => ({
      url: t.url,
      width: t.width,
      height: t.height,
    }))
    .filter((t: Thumbnail) => typeof t.url === "string" && t.url.length > 0);
}

/**
 * Walk a thumbnail-shaped subtree looking for any `thumbnails: [...]`
 * array. User-owned playlists in home shelves wrap the stacked 4-track
 * collage in renderer variants we don't enumerate explicitly
 * (musicCardShelfThumbnailRenderer, etc.) — so when the direct paths
 * fail, fall back to a scoped recursive search.
 */
export function deepFindThumbnails(node: YtNode | undefined): Thumbnail[] {
  if (!node || typeof node !== "object") return [];
  const seen = new WeakSet<object>();
  let result: Thumbnail[] = [];
  const walk = (n: unknown) => {
    if (result.length || !n || typeof n !== "object") return;
    if (seen.has(n as object)) return;
    seen.add(n as object);
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const obj = n as YtNode;
    if (Array.isArray(obj.thumbnails) && obj.thumbnails.length) {
      const mapped = (obj.thumbnails as YtNode[])
        .map((t) => ({ url: t.url, width: t.width, height: t.height }))
        .filter(
          (t: Thumbnail) => typeof t.url === "string" && t.url.length > 0,
        );
      if (mapped.length) {
        result = mapped;
        return;
      }
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  return result;
}

export function readRuns(node: YtNode | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) {
    return node.runs.map((r: YtNode) => r.text ?? "").join("");
  }
  return "";
}

/**
 * True when the text plausibly represents a date the user would expect to
 * see in the "Added" column. Recognizes:
 *   - bare 4-digit year in the 1900-2100 range (album years)
 *   - English/Russian month name tokens ("Apr 23", "12 апр.")
 *   - "X ago / назад", "yesterday / today", and their RU equivalents
 *   - common slash/dash date formats (3/12/24, 2024-04-23)
 * Reject pure numerics — those are play counts, not dates.
 */
function looksLikeDate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^\d{4}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n >= 1900 && n <= 2100;
  }
  if (/(?:\bago\b|назад)/i.test(trimmed)) return true;
  if (/^(?:yesterday|today|сегодня|вчера)$/i.test(trimmed)) return true;
  if (
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)/i.test(
      trimmed,
    )
  )
    return true;
  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(trimmed)) return true;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) return true;
  return false;
}

/**
 * Parse a duration string like "3:42" or "1:05:03" into seconds.
 */
export function parseDuration(text: string): number | undefined {
  if (!text) return undefined;
  const parts = text.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

export function pageTypeToKind(pageType: string): ShelfItem["kind"] | null {
  if (pageType.includes("ARTIST")) return "artist";
  if (pageType.includes("ALBUM")) return "album";
  if (pageType.includes("PLAYLIST") || pageType.includes("PODCAST_SHOW"))
    return "playlist";
  return null;
}

/**
 * Map a `musicNavigationButtonRenderer` — the colored category tile used
 * on the Moods & Genres page (and as the top buttons on Explore) — to
 * our ShelfItem shape with kind="category".
 *
 * The button carries its own background color in `solid.leftStripeColor`
 * as a signed 32-bit ARGB int (e.g. -16777216 → 0xFF000000). We unsign
 * with `>>> 0`, take the trailing 6 hex digits as RGB, and ignore alpha
 * — every category we've seen in the wild has alpha=255.
 *
 * `clickCommand.browseEndpoint.params` is opaque continuation token that
 * must be passed along with `browseId` on the follow-up browse call to
 * load that category's playlists.
 */
export function mapNavigationButton(raw: YtNode): ShelfItem | null {
  const title = readRuns(raw.buttonText);
  if (!title) return null;

  const browse = raw.clickCommand?.browseEndpoint;
  const browseId: string | undefined = browse?.browseId;
  if (!browseId) return null;

  const params: string | undefined = browse?.params;

  let tint: string | undefined;
  const colorInt = raw.solid?.leftStripeColor;
  if (typeof colorInt === "number") {
    const argb = (colorInt >>> 0).toString(16).padStart(8, "0");
    tint = `#${argb.slice(2)}`;
  }

  return {
    kind: "category",
    id: browseId,
    title,
    thumbnails: [],
    categoryParams: params,
    tint,
  };
}

/**
 * Given a musicTwoRowItemRenderer (the typical card in shelves/carousels),
 * normalize it to our ShelfItem shape.
 */
export function mapTwoRowItem(raw: YtNode): ShelfItem | null {
  const endpoint = raw.navigationEndpoint ?? {};
  const browseEndpoint = endpoint.browseEndpoint;
  const watchEndpoint = endpoint.watchEndpoint;

  const title = readRuns(raw.title);
  const subtitle = readRuns(raw.subtitle);

  // Walk the subtitle runs to pull out artist nav endpoints. The flat
  // subtitle string ("Song • Скриптонит") still drives shelf-card
  // display, but populating `artists` lets the player card render
  // each artist as a clickable link instead of inert text.
  const subtitleRuns: YtNode[] = raw.subtitle?.runs ?? [];
  const artists: { id?: string; name: string }[] = [];
  for (const run of subtitleRuns) {
    const browseId = run.navigationEndpoint?.browseEndpoint?.browseId as
      string | undefined;
    const pageType = run.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
      ?.pageType as string | undefined;
    if (browseId && pageType?.includes("ARTIST")) {
      artists.push({ id: browseId, name: run.text ?? "" });
    }
  }

  let thumbnails = readThumbnails(
    raw.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail ??
      raw.thumbnail?.musicThumbnailRenderer?.thumbnail ??
      raw.thumbnail,
  );
  if (thumbnails.length === 0) {
    thumbnails = deepFindThumbnails(raw.thumbnailRenderer);
    if (thumbnails.length === 0) {
      thumbnails = deepFindThumbnails(raw.thumbnail);
    }
  }

  let kind: ShelfItem["kind"] = "song";
  let id = "";
  let round = false;

  if (watchEndpoint?.videoId) {
    id = watchEndpoint.videoId;
    // Music videos vs. song cards: YT returns 16:9 thumbnails for videos
    // and 1:1 for songs. The watchEndpoint itself doesn't tell us which,
    // but the thumbnail aspect ratio is a reliable signal.
    const widest = thumbnails.reduce(
      (m, t) => ((t.width ?? 0) > (m?.width ?? 0) ? t : m),
      thumbnails[0],
    );
    const ratio =
      widest && widest.width && widest.height
        ? widest.width / widest.height
        : 1;
    kind = ratio > 1.4 ? "video" : "song";
  } else if (browseEndpoint?.browseId) {
    id = browseEndpoint.browseId;
    const pageType =
      browseEndpoint.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType ?? "";
    const mapped = pageTypeToKind(pageType);
    if (mapped) {
      kind = mapped;
      if (mapped === "artist") round = true;
    }
  }

  if (!id) return null;

  // YT Music ships some long-form videos as "playlist" cards (auto-generated
  // chapter list from description timestamps). Visually still a playlist
  // square, but the play button on the card itself targets a watchEndpoint —
  // we surface that videoId so the click handler can play it directly.
  let playableVideoId: string | undefined;
  if (kind === "playlist") {
    playableVideoId =
      raw.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
        ?.videoId;
  }

  return {
    kind,
    id,
    title,
    subtitle: subtitle || undefined,
    thumbnails,
    round,
    explicit: readExplicit(raw) || undefined,
    playableVideoId,
  };
}

/**
 * Given a musicResponsiveListItemRenderer (the typical row in a song shelf),
 * normalize it to our ShelfItem shape. Pulls artists, album, and duration
 * from the flex/fixed columns when available.
 */
export function mapResponsiveListItem(raw: YtNode): ShelfItem | null {
  const flex: YtNode[] = raw.flexColumns ?? [];
  const fixed: YtNode[] = raw.fixedColumns ?? [];

  const titleCol =
    flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
  const title = readRuns(
    flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text,
  );

  // Walk every flex column past the title. Layouts vary: regular playlist
  // rows have "Artist • Album" in flex[1]; album-page rows have "X plays"
  // there; user-owned playlist rows split artist / album / date-added
  // across flex[1..3]. We classify each column by what's inside it.
  const artists: { id?: string; name: string }[] = [];
  let album: string | undefined;
  let albumId: string | undefined;
  let playCount: string | undefined;
  let dateAdded: string | undefined;

  for (let i = 1; i < flex.length; i++) {
    const colNode = flex[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
    if (!colNode) continue;
    const runs: YtNode[] = colNode.runs ?? [];
    let hadNav = false;
    let plainText = "";
    for (const run of runs) {
      plainText += run.text ?? "";
      const nav = run.navigationEndpoint;
      const browseId = nav?.browseEndpoint?.browseId as string | undefined;
      const pageType = nav?.browseEndpoint
        ?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType as string | undefined;
      if (browseId && pageType?.includes("ARTIST")) {
        artists.push({ id: browseId, name: run.text ?? "" });
        hadNav = true;
      } else if (browseId && pageType?.includes("ALBUM")) {
        album = run.text ?? album;
        albumId = browseId;
        hadNav = true;
      }
    }
    if (hadNav) continue;
    const wholeText = (plainText || colNode.simpleText || "").trim();
    if (!wholeText) continue;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(wholeText)) continue;
    // Play counts come in two flavors:
    //   - "1.2M plays" / "5,234 views" — explicit keyword in any locale.
    //   - Bare number like "1,234,567" or "1.2M" — what artist Top Songs
    //     ships on WEB_REMIX (no "plays" suffix in the payload). Match a
    //     compact numeric/abbreviated form anchored at start to avoid
    //     pulling in "Sep 12, 2023" / "2 days ago" / channel names.
    const isCounter =
      /plays|views|просл|просмотр|播放|观看/i.test(wholeText) ||
      /^\d[\d\s.,]*\s*[KMBkmbКМБкмбТтт]*$/.test(wholeText);
    if (isCounter) {
      if (!playCount) playCount = wholeText;
    } else if (looksLikeDate(wholeText) && !dateAdded) {
      // Tighter check than "has any digit" — avoided promoting channel
      // names like "21 Savage" / "100 gecs" / "PE4A" into the date column.
      dateAdded = wholeText;
    }
  }

  // Duration can be in fixedColumns or the last run of the subtitle.
  let duration: number | undefined;
  const durationText = readRuns(
    fixed[0]?.musicResponsiveListItemFixedColumnRenderer?.text,
  );
  if (durationText) duration = parseDuration(durationText);
  if (duration === undefined) {
    const subtitleRuns: YtNode[] =
      flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    if (subtitleRuns.length > 0) {
      const last = subtitleRuns[subtitleRuns.length - 1];
      if (typeof last.text === "string") duration = parseDuration(last.text);
    }
  }

  const explicit = readExplicit(raw);

  let thumbnails = readThumbnails(
    raw.thumbnail?.musicThumbnailRenderer?.thumbnail,
  );

  const videoId: string | undefined =
    titleCol?.navigationEndpoint?.watchEndpoint?.videoId ??
    raw.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
      ?.videoId ??
    raw.playlistItemData?.videoId ??
    raw.navigationEndpoint?.watchEndpoint?.videoId;

  // YT Music sometimes ships rows without a music-style thumbnail (more
  // common on user-created playlists than on Liked Songs). Every public
  // video has a generated `i.ytimg.com/vi/{id}/...jpg` set, so we
  // synthesize one from the videoId when the row came up empty.
  if (thumbnails.length === 0 && videoId) {
    thumbnails = [
      {
        url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        width: 320,
        height: 180,
      },
      {
        url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        width: 480,
        height: 360,
      },
    ];
  }

  // Some rows are navigational (to artist/album/playlist) instead of playable.
  const navBrowseId: string | undefined =
    titleCol?.navigationEndpoint?.browseEndpoint?.browseId ??
    raw.navigationEndpoint?.browseEndpoint?.browseId;
  const navPageType: string =
    titleCol?.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
      ?.pageType ??
    raw.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
      ?.pageType ??
    "";

  const subtitleText =
    artists.map((a) => a.name).join(", ") ||
    readRuns(flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text);

  if (videoId) {
    return {
      kind: "song",
      id: videoId,
      title,
      subtitle: subtitleText || undefined,
      thumbnails,
      artists: artists.length ? artists : undefined,
      album,
      albumId,
      duration,
      explicit: explicit || undefined,
      playCount,
      dateAdded,
    };
  }

  if (navBrowseId) {
    const kind = pageTypeToKind(navPageType);
    if (!kind) return null;
    return {
      kind,
      id: navBrowseId,
      title,
      subtitle: subtitleText || undefined,
      thumbnails,
      round: kind === "artist",
      explicit: explicit || undefined,
    };
  }

  return null;
}

/**
 * Walk the entire response tree and collect every
 * `musicResponsiveListItemRenderer` node. Album / playlist responses
 * vary wildly (singleColumnBrowseResultsRenderer vs
 * twoColumnBrowseResultsRenderer, musicPlaylistShelfRenderer vs
 * musicShelfRenderer, occasional grid wrappers), so we give up on the
 * nested path and walk the whole thing.
 */
export function collectResponsiveRows(root: unknown): YtNode[] {
  const out: YtNode[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }

    const n = node as YtNode;
    if (n.musicResponsiveListItemRenderer) {
      out.push(n.musicResponsiveListItemRenderer);
    }
    for (const key of Object.keys(n)) {
      walk(n[key]);
    }
  };
  walk(root);
  return out;
}

/**
 * Walk a section-list tree and return every musicCarouselShelfRenderer /
 * musicShelfRenderer node. Handles the itemSectionRenderer / sectionListRenderer
 * wrappers that YTM nests shelves inside.
 */
export function collectShelfNodes(sections: YtNode[]): YtNode[] {
  const out: YtNode[] = [];
  const walk = (node: YtNode | undefined) => {
    if (!node) return;
    if (
      node.musicCarouselShelfRenderer ||
      node.musicShelfRenderer ||
      node.musicCardShelfRenderer
    ) {
      out.push(node);
      return;
    }
    if (node.itemSectionRenderer?.contents) {
      for (const c of node.itemSectionRenderer.contents) walk(c);
    }
    if (node.sectionListRenderer?.contents) {
      for (const c of node.sectionListRenderer.contents) walk(c);
    }
    if (node.gridRenderer?.items) {
      // gridRenderer wraps raw two-row items; synthesize a shelf-like node.
      out.push({
        musicShelfRenderer: {
          title: node.gridRenderer.header?.gridHeaderRenderer?.title,
          contents: node.gridRenderer.items,
        },
      });
    }
  };
  sections.forEach(walk);
  return out;
}

/**
 * musicCardShelfRenderer is the "Quick picks" style shelf: a featured
 * track up top (title/subtitle/thumbnail/onTap on the renderer itself),
 * plus a list of musicResponsiveListItemRenderer rows in `contents`.
 * We surface the featured track as the first item of the shelf.
 */
function mapCardShelfFeatured(card: YtNode): ShelfItem | null {
  const videoId: string | undefined = card.onTap?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const title = readRuns(card.title);
  if (!title) return null;
  const subtitle = readRuns(card.subtitle);
  const thumbnails = readThumbnails(
    card.thumbnail?.musicThumbnailRenderer?.thumbnail,
  );
  return {
    kind: "song",
    id: videoId,
    title,
    subtitle: subtitle || undefined,
    thumbnails,
    explicit: readExplicit(card) || undefined,
  };
}

/**
 * Convert a shelf wrapper (carousel or shelf) into our Shelf DTO by mapping
 * every child renderer it contains.
 */
export function mapShelfWrapper(
  wrapper: YtNode,
  index: number,
): { title: string; items: ShelfItem[]; display: "list" | "card" | "grid" } {
  const card = wrapper.musicCardShelfRenderer;
  const music =
    wrapper.musicCarouselShelfRenderer ?? wrapper.musicShelfRenderer ?? card;
  if (!music) return { title: "", items: [], display: "card" };

  const title = card
    ? readRuns(card.header?.musicCardShelfHeaderBasicRenderer?.title)
    : readRuns(
        music.header?.musicCarouselShelfBasicHeaderRenderer?.title ??
          music.title,
      );
  const rawItems: YtNode[] = music.contents ?? [];

  const items: ShelfItem[] = [];
  let sawResponsive = false;
  let sawTwoRow = false;
  let sawNavButton = false;
  for (const c of rawItems) {
    const two = c.musicTwoRowItemRenderer;
    const responsive = c.musicResponsiveListItemRenderer;
    const navButton = c.musicNavigationButtonRenderer;
    if (two) {
      sawTwoRow = true;
      const mapped = mapTwoRowItem(two);
      if (mapped) items.push(mapped);
    } else if (responsive) {
      sawResponsive = true;
      const mapped = mapResponsiveListItem(responsive);
      if (mapped) items.push(mapped);
    } else if (navButton) {
      sawNavButton = true;
      const mapped = mapNavigationButton(navButton);
      if (mapped) items.push(mapped);
    }
  }

  if (card) {
    const featured = mapCardShelfFeatured(card);
    if (featured) items.unshift(featured);
  }

  // Layout pick: "grid" when the shelf is exclusively colored category
  // tiles (Moods & Genres), "list" when the shelf is exclusively row
  // renderers (Top Songs on artist pages, Quick picks card shelf), and
  // "card" otherwise. Mixed shelves fall through to "card".
  const display: "list" | "card" | "grid" =
    sawNavButton && !sawTwoRow && !sawResponsive
      ? "grid"
      : sawResponsive && !sawTwoRow
        ? "list"
        : "card";

  return { title: title || `Section ${index + 1}`, items, display };
}
