import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import {
  durationMatches,
  hitMatches,
  normalizeForMatch,
} from "@/lib/lyrics/match";

/**
 * Musixmatch — unofficial reverse-engineered web-desktop client. The
 * official API requires a paid commercial agreement; the desktop web app
 * uses an `apic-desktop.musixmatch.com` endpoint with a per-session
 * `usertoken` obtained from a free `token.get` call. That's the same
 * approach the open-source `syncedlyrics` Python library takes, and it's
 * what other unofficial clients have used for years — it's unofficial,
 * but stable enough to be worth integrating.
 *
 * Tauri's HTTP plugin is required because:
 *   - `apic-desktop.musixmatch.com` does NOT set permissive CORS, so a
 *     plain `fetch()` from the webview would be blocked.
 *   - We need to set a real `User-Agent`, which the webview prohibits
 *     from JS-level `fetch` (forbidden header).
 *   - The host must also be in `src-tauri/capabilities/default.json` —
 *     `tauri-plugin-http` silently rejects unlisted hosts at the Rust
 *     boundary before any network call.
 */

const API_BASE = "https://apic-desktop.musixmatch.com/ws/1.1";
const APP_ID = "web-desktop-app-v1.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Token TTL: Musixmatch's user_token is valid until the server invalidates
// it (~10 minutes in practice). We cache slightly under that, and on a
// 401-shaped response we drop the cache and retry once.
const TOKEN_TTL_MS = 9 * 60 * 1000;
const TOKEN_STORAGE_KEY = "musixmatch-user-token";

type MusixmatchParams = {
  title: string;
  artist?: string;
  /** Duration in seconds — vouches for exact-title hits when no artist
   *  metadata exists to verify against (see findTrackId). */
  duration?: number;
};

type CachedToken = { token: string; loadedAt: number };

let memoryToken: CachedToken | null = null;

function loadStoredToken(): CachedToken | null {
  if (memoryToken) return memoryToken;
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedToken;
    if (
      parsed &&
      typeof parsed.token === "string" &&
      typeof parsed.loadedAt === "number"
    ) {
      memoryToken = parsed;
      return parsed;
    }
  } catch {
    /* corrupted entry — fall through */
  }
  return null;
}

function saveToken(token: string): CachedToken {
  const entry: CachedToken = { token, loadedAt: Date.now() };
  memoryToken = entry;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* keep in-memory copy */
  }
  return entry;
}

function invalidateToken(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* noop */
  }
}

async function fetchToken(signal?: AbortSignal): Promise<string | null> {
  const cached = loadStoredToken();
  if (cached && Date.now() - cached.loadedAt < TOKEN_TTL_MS) {
    return cached.token;
  }
  const url = `${API_BASE}/token.get?app_id=${APP_ID}&format=json`;
  try {
    const r = await tauriFetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal,
    });
    if (!r.ok) return null;
    const json = (await r.json()) as MxmEnvelope<{ user_token?: string }>;
    const token = json?.message?.body?.user_token;
    // Musixmatch returns a literal "UpgradeOnlyUpgradeOnly..." token when
    // the IP is flagged or the captcha gate is active — the token shape
    // looks valid but any subsequent call will 401. Reject up front.
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      /UpgradeOnly/.test(token)
    ) {
      return null;
    }
    return saveToken(token).token;
  } catch {
    return null;
  }
}

type MxmEnvelope<B> = {
  message?: {
    header?: { status_code?: number };
    body?: B;
  };
};

type MxmSearchBody = {
  track_list?: Array<{
    track?: {
      track_id?: number;
      track_name?: string;
      artist_name?: string;
      has_subtitles?: number;
      has_lyrics?: number;
      instrumental?: number;
      track_length?: number;
    };
  }>;
};

type MxmSubtitleBody = {
  subtitle?: { subtitle_body?: string };
};

type MxmLyricsBody = {
  lyrics?: { lyrics_body?: string; instrumental?: number };
};

export async function fetchMusixmatchLyrics(
  p: MusixmatchParams,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  // Two-pass to handle token expiry: if any call returns 401, drop the
  // cached token and retry once with a fresh one. Both passes share the
  // caller's signal, so the provider's total time budget stays bounded.
  let result = await tryFetch(p, signal);
  if (result === "auth-failure") {
    invalidateToken();
    result = await tryFetch(p, signal);
  }
  // Every step above swallows its own fetch errors into null, which
  // would cache a mid-chain timeout as a permanent "no lyrics" for an
  // hour. Rethrow instead so react-query treats it as the transient
  // failure it is (retry now, re-fetch on the next mount).
  if (signal?.aborted && (result === null || result === "auth-failure")) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Musixmatch timed out");
  }
  return result === "auth-failure" ? null : result;
}

type TryFetchResult = Lyrics | null | "auth-failure";

async function tryFetch(
  p: MusixmatchParams,
  signal?: AbortSignal,
): Promise<TryFetchResult> {
  const token = await fetchToken(signal);
  if (!token) return null;

  const trackId = await findTrackId(p, token, signal);
  if (trackId === "auth-failure") return "auth-failure";
  if (!trackId) return null;

  const subtitle = await getSubtitle(trackId, token, signal);
  if (subtitle === "auth-failure") return "auth-failure";
  if (subtitle) {
    const lines = parseLRC(subtitle);
    if (lines.length > 0) {
      return { kind: "timed", lines, source: "Musixmatch" };
    }
  }

  const plain = await getPlainLyrics(trackId, token, signal);
  if (plain === "auth-failure") return "auth-failure";
  if (plain) return { kind: "plain", text: plain, source: "Musixmatch" };

  return null;
}

async function findTrackId(
  p: MusixmatchParams,
  token: string,
  signal?: AbortSignal,
): Promise<number | null | "auth-failure"> {
  const url = new URL(`${API_BASE}/track.search`);
  url.searchParams.set("q_track", p.title);
  if (p.artist) url.searchParams.set("q_artist", p.artist);
  url.searchParams.set("page_size", "5");
  url.searchParams.set("page", "1");
  url.searchParams.set("s_track_rating", "desc");
  url.searchParams.set("quorum_factor", "1.0");
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);

  try {
    const r = await tauriFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal,
    });
    // A stale/flagged token can be rejected at the HTTP layer (401/403),
    // not only via the envelope status_code — treat both as auth failures
    // so the token-invalidate-and-retry path actually fires.
    if (r.status === 401 || r.status === 403) return "auth-failure";
    if (!r.ok) return null;
    const json = (await r.json()) as MxmEnvelope<MxmSearchBody>;
    if (json?.message?.header?.status_code === 401) return "auth-failure";
    const rawList = json?.message?.body?.track_list ?? [];
    // track.search is fuzzy and returns something even when Musixmatch
    // lacks this track, which surfaces a confidently-wrong different song.
    // Keep only hits whose title/artist plausibly match the request before
    // the synced/plain preference picks the "best" one.
    const reqTitle = normalizeForMatch(p.title);
    const reqArtist = normalizeForMatch(p.artist ?? "");
    const list = rawList.filter((t) =>
      hitMatches(
        reqTitle,
        reqArtist,
        normalizeForMatch(t.track?.track_name ?? ""),
        normalizeForMatch(t.track?.artist_name ?? ""),
      ),
    );
    // A bare title is not identity: with no request artist to verify
    // against, hitMatches passes any exact-title hit, so a different
    // song with the same name slips through. Require the track length
    // to vouch for the match instead; no duration to check means no
    // lyrics rather than confidently-wrong ones.
    const verified = reqArtist
      ? list
      : list.filter((t) => durationMatches(p.duration, t.track?.track_length));
    // Prefer a track with synced subtitles; fall back to any track with
    // lyrics. The result list is already sorted by rating descending, so
    // the first hit in either pool is the best one.
    const synced = verified.find((t) => t.track?.has_subtitles === 1);
    if (synced?.track?.track_id) return synced.track.track_id;
    const plain = verified.find((t) => t.track?.has_lyrics === 1);
    if (plain?.track?.track_id) return plain.track.track_id;
    return null;
  } catch {
    return null;
  }
}

async function getSubtitle(
  trackId: number,
  token: string,
  signal?: AbortSignal,
): Promise<string | null | "auth-failure"> {
  const url = new URL(`${API_BASE}/track.subtitle.get`);
  url.searchParams.set("track_id", String(trackId));
  url.searchParams.set("subtitle_format", "lrc");
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);

  try {
    const r = await tauriFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal,
    });
    if (r.status === 401 || r.status === 403) return "auth-failure";
    if (!r.ok) return null;
    const json = (await r.json()) as MxmEnvelope<MxmSubtitleBody>;
    if (json?.message?.header?.status_code === 401) return "auth-failure";
    const body = json?.message?.body?.subtitle?.subtitle_body;
    return typeof body === "string" && body.trim() ? body : null;
  } catch {
    return null;
  }
}

async function getPlainLyrics(
  trackId: number,
  token: string,
  signal?: AbortSignal,
): Promise<string | null | "auth-failure"> {
  const url = new URL(`${API_BASE}/track.lyrics.get`);
  url.searchParams.set("track_id", String(trackId));
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);

  try {
    const r = await tauriFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal,
    });
    if (r.status === 401 || r.status === 403) return "auth-failure";
    if (!r.ok) return null;
    const json = (await r.json()) as MxmEnvelope<MxmLyricsBody>;
    if (json?.message?.header?.status_code === 401) return "auth-failure";
    if (json?.message?.body?.lyrics?.instrumental === 1) {
      return "🎵 Instrumental";
    }
    const body = json?.message?.body?.lyrics?.lyrics_body;
    return typeof body === "string" && body.trim() ? body : null;
  } catch {
    return null;
  }
}
