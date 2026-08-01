import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { selectBest, type ScoreCandidate } from "@/lib/lyrics/score";
import {
  createDeadline,
  isTransientStatus,
  lyricsFetch,
  LyricsRateLimitError,
  throwForStatus,
  type Deadline,
} from "@/lib/lyrics/http";

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

async function fetchToken(deadline: Deadline): Promise<string> {
  const cached = loadStoredToken();
  if (cached && Date.now() - cached.loadedAt < TOKEN_TTL_MS) {
    return cached.token;
  }
  const url = `${API_BASE}/token.get?app_id=${APP_ID}&format=json`;
  const r = await lyricsFetch(url, deadline, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  if (!r.ok) throwForStatus(r.status, "Musixmatch token.get");
  const json = (await r.json()) as MxmEnvelope<{ user_token?: string }>;
  const token = json?.message?.body?.user_token;
  // Musixmatch returns a literal "UpgradeOnlyUpgradeOnly..." token when
  // the IP is flagged or the captcha gate is active, and the token shape
  // looks valid but any subsequent call will 401.
  //
  // This throws rather than returning null, and the distinction matters:
  // being rate-limited says nothing about whether this track has lyrics.
  // Musixmatch gates aggressively (roughly 20 requests per IP per two
  // minutes), so returning null here is what turned a burst of track
  // skipping into a day of cached "No lyrics found." on disk.
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    /UpgradeOnly/.test(token)
  ) {
    throw new LyricsRateLimitError(
      "Musixmatch declined to issue a token",
    );
  }
  return saveToken(token).token;
}

/** Musixmatch answers 200 OK and puts the real status in the envelope, so
 *  the HTTP status alone never tells you what happened. */
function envelopeStatus(json: MxmEnvelope<unknown>): number | undefined {
  return json?.message?.header?.status_code;
}

/**
 * Turn one Musixmatch response into either a parsed envelope, the
 * auth-failure sentinel, or a throw.
 *
 * 401/403 at either layer is the token going stale, which the caller
 * recovers from by re-issuing one. 5xx and 429 are the provider's problem
 * and must not be mistaken for "this track has no lyrics". A 404 in the
 * envelope is a real answer and is left for the caller to read.
 */
async function readEnvelope<B>(
  r: Response,
  what: string,
): Promise<MxmEnvelope<B> | "auth-failure"> {
  if (r.status === 401 || r.status === 403) return "auth-failure";
  if (!r.ok) throwForStatus(r.status, `Musixmatch ${what}`);
  const json = (await r.json()) as MxmEnvelope<B>;
  const status = envelopeStatus(json);
  if (status === 401 || status === 403) return "auth-failure";
  if (status !== undefined && (status === 429 || isTransientStatus(status))) {
    throwForStatus(status, `Musixmatch ${what} envelope`);
  }
  return json;
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

  const deadline = createDeadline(signal);
  try {
    // Two-pass to handle token expiry: if any call returns 401, drop the
    // cached token and retry once with a fresh one.
    let result = await tryFetch(p, deadline);
    if (result === "auth-failure") {
      invalidateToken();
      result = await tryFetch(p, deadline);
    }
    // Still refused after a fresh token: the account or IP is gated, which
    // is a failure to look up, not a track without lyrics. Throw so it is
    // retried later rather than persisted as an answer.
    if (result === "auth-failure") {
      throw new LyricsRateLimitError(
        "Musixmatch rejected the token twice",
      );
    }
    return result;
  } finally {
    deadline.done();
  }
}

type TryFetchResult = Lyrics | null | "auth-failure";

async function tryFetch(
  p: MusixmatchParams,
  deadline: Deadline,
): Promise<TryFetchResult> {
  const token = await fetchToken(deadline);

  const trackId = await findTrackId(p, token, deadline);
  if (trackId === "auth-failure") return "auth-failure";
  // Musixmatch searched and came up empty. A real answer.
  if (!trackId) return null;

  const subtitle = await getSubtitle(trackId, token, deadline);
  if (subtitle === "auth-failure") return "auth-failure";
  if (subtitle) {
    const lines = parseLRC(subtitle);
    if (lines.length > 0) {
      return { kind: "timed", lines, source: "Musixmatch" };
    }
  }

  const plain = await getPlainLyrics(trackId, token, deadline);
  if (plain === "auth-failure") return "auth-failure";
  if (plain) return { kind: "plain", text: plain, source: "Musixmatch" };

  return null;
}

async function findTrackId(
  p: MusixmatchParams,
  token: string,
  deadline: Deadline,
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

  // A stale/flagged token can be rejected at the HTTP layer (401/403), not
  // only via the envelope status_code. `readEnvelope` treats both as auth
  // failures so the token-invalidate-and-retry path actually fires.
  const r = await lyricsFetch(url.toString(), deadline, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  const json = await readEnvelope<MxmSearchBody>(r, "track.search");
  if (json === "auth-failure") return "auth-failure";
  const list = json?.message?.body?.track_list ?? [];

  // Score the hits instead of taking the first one with subtitles. This was
  // the least verified provider in the app: it read neither track_name nor
  // artist_name from a response that contains both, so a title Musixmatch
  // happens to rank highly was accepted whatever song it belonged to.
  //
  // The has_subtitles preference is gone for the same reason the LRCLIB
  // synced pre-filter went: preferring timings over correctness picks a
  // confidently wrong song over a right one.
  type Row = (typeof list)[number];
  const candidates: (ScoreCandidate & { row: Row })[] = list
    .filter((t) => t.track?.has_lyrics === 1 || t.track?.has_subtitles === 1)
    .map((t) => ({
      row: t,
      trackName: t.track?.track_name ?? "",
      artistName: t.track?.artist_name ?? "",
    }));

  const best = selectBest({ title: p.title, artist: p.artist }, candidates, {
    durationBlind: true,
    bodyUnknown: true,
  });
  return best?.record.row.track?.track_id ?? null;
}

async function getSubtitle(
  trackId: number,
  token: string,
  deadline: Deadline,
): Promise<string | null | "auth-failure"> {
  const url = new URL(`${API_BASE}/track.subtitle.get`);
  url.searchParams.set("track_id", String(trackId));
  url.searchParams.set("subtitle_format", "lrc");
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);

  const r = await lyricsFetch(url.toString(), deadline, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  const json = await readEnvelope<MxmSubtitleBody>(r, "track.subtitle.get");
  if (json === "auth-failure") return "auth-failure";
  // An empty body here means Musixmatch has no synced lyrics for this
  // track. That is an answer, and the caller falls back to plain text.
  const body = json?.message?.body?.subtitle?.subtitle_body;
  return typeof body === "string" && body.trim() ? body : null;
}

async function getPlainLyrics(
  trackId: number,
  token: string,
  deadline: Deadline,
): Promise<string | null | "auth-failure"> {
  const url = new URL(`${API_BASE}/track.lyrics.get`);
  url.searchParams.set("track_id", String(trackId));
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);

  const r = await lyricsFetch(url.toString(), deadline, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  const json = await readEnvelope<MxmLyricsBody>(r, "track.lyrics.get");
  if (json === "auth-failure") return "auth-failure";
  if (json?.message?.body?.lyrics?.instrumental === 1) {
    return "🎵 Instrumental";
  }
  const body = json?.message?.body?.lyrics?.lyrics_body;
  return typeof body === "string" && body.trim() ? body : null;
}
