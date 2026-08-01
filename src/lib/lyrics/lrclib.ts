import { getVersion } from "@tauri-apps/api/app";
import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { romanizedArtist } from "@/lib/lyrics/match";
import { selectBest, type ScoreQuery } from "@/lib/lyrics/score";
import { reattributedFromTitle } from "@/lib/track-meta";
import {
  createDeadline,
  lyricsFetch,
  throwForStatus,
  type Deadline,
} from "@/lib/lyrics/http";

/**
 * LRCLIB (https://lrclib.net) — free, open lyrics database with synced
 * LRC-format lyrics.
 *
 * Tauri's HTTP plugin is required, same as Musixmatch and Genius. LRCLIB
 * itself does send permissive CORS headers, so a webview `fetch()` looks
 * like it should work, and it does in `tauri dev`, which is exactly why
 * this shipped broken. CORS is not the binding constraint: our own
 * `app.security.csp` in `src-tauri/tauri.conf.json` declares an explicit
 * `connect-src` listing only `'self'` and localhost. Tauri injects that CSP
 * when serving `build.frontendDist` and never against `build.devUrl`, so a
 * plain `fetch("https://lrclib.net/...")` succeeds in dev and is blocked in
 * every packaged build, silently taking out the only duration-aware
 * provider and leaving the weaker sources to answer alone.
 *
 * Going through `tauriFetch` sidesteps the CSP (the request is made by Rust,
 * not the webview) and lets us send `Lrclib-Client`, which LRCLIB asks
 * third-party clients for and which the webview forbids from JS.
 * `lrclib.net` must therefore be in `src-tauri/capabilities/default.json`:
 * `tauri-plugin-http` rejects unlisted hosts at the Rust boundary before any
 * network call. `hosts.test.ts` guards both halves of that.
 */

// Resolved once, lazily. Hardcoding the version here would silently go stale
// on the next release bump, and `getVersion` is async, so the header is built
// on first use and reused. Falls back to an unversioned string outside a
// Tauri context.
let cachedHeaders: Record<string, string> | null = null;

async function headers(): Promise<Record<string, string>> {
  if (cachedHeaders) return cachedHeaders;
  let version = "";
  try {
    version = ` v${await getVersion()}`;
  } catch {
    /* not running under Tauri */
  }
  cachedHeaders = {
    Accept: "application/json",
    "Lrclib-Client": `YTubic${version} (https://github.com/NUber-dev/YTubic)`,
  };
  return cachedHeaders;
}

type LrclibParams = {
  title: string;
  artist?: string;
  album?: string;
  /** Duration in seconds. LRCLIB uses this to disambiguate matches. */
  duration?: number;
};

type LrclibRecord = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
};

export async function fetchLrclibLyrics(
  p: LrclibParams,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const deadline = createDeadline(signal);
  try {
    const first = await lookup(p, deadline);
    if (first) return first;

    // Nothing under the ordinary reading. If this looks like a re-upload
    // with the artist in the title and a channel name in the artist field,
    // try it the other way round. Only ever a second attempt, so a wrong
    // guess costs a request rather than a wrong answer.
    const alt = reattributedFromTitle(p.title, p.artist);
    if (!alt) return null;
    return await lookup({ ...p, title: alt.title, artist: alt.artist }, deadline);
  } finally {
    deadline.done();
  }
}

async function lookup(
  p: LrclibParams,
  deadline: Deadline,
): Promise<Lyrics | null> {
  // Race /get against /search. /get is the strict exact-match endpoint
  // (tight title+artist+duration match → fastest path when YT's
  // metadata happens to line up with LRCLIB's record), /search is the
  // fuzzy fallback. Running both concurrently means a /get miss no
  // longer adds the /search latency on top — worst-case becomes
  // max(get, search) ≈ 300 ms instead of get + search ≈ 500 ms. The
  // cost is one extra HTTP request when /get hits, which LRCLIB is
  // explicitly fine with (no advertised rate limit).
  //
  // We still PREFER /get's record when both succeed — it's a tighter
  // match on the same track, while /search may have picked a
  // re-master / live version.
  //
  // `allSettled`, not `all`: with `all`, a 5xx from either endpoint
  // rejected the pair and threw away a perfectly good record from the
  // other. One endpoint answering is enough.
  // A third query when the artist is Cyrillic. The provider filters by
  // artist server-side and by containment, so "Скриптонит" never returns
  // the rows filed as "Skryptonite" no matter how well the scorer would
  // rank them. Both spellings have to be asked for. The scorer still
  // decides, and dedups by lyric body, so the extra rows cost nothing but
  // one request.
  // Title-only, NOT artist-less: p.artist stays set, so the scorer still
  // verifies every row it brings back. Broadening what is RETRIEVED is a
  // different thing from dropping the constraint that VERIFIES.
  const romanized = romanizedArtist(p.artist);
  const [getR, searchR, romanR] = await Promise.allSettled([
    p.artist ? lrclibGet(p, deadline) : Promise.resolve(null),
    lrclibSearch(p, deadline),
    romanized
      ? lrclibSearch({ ...p, artist: undefined }, deadline)
      : Promise.resolve([]),
  ]);

  const get = getR.status === "fulfilled" ? getR.value : null;
  const search = [
    ...(searchR.status === "fulfilled" ? (searchR.value ?? []) : []),
    ...(romanR.status === "fulfilled" ? (romanR.value ?? []) : []),
  ];

  // One scored pool rather than a precedence rule between the endpoints.
  // /get's exact match used to win by default, but its +/-2s window
  // validates the metadata field, not the body: a live probe for a 248s
  // track returned a record whose lyrics run 68s past the end.
  const query: ScoreQuery = {
    title: p.title,
    artist: p.artist,
    durationSec: p.duration,
  };
  const best = selectBest(query, [...(get ? [get] : []), ...search]);
  if (best) return mapRecord(best.record, best.verdict.suppressSynced);

  // Nothing survived scoring. Whether that is an answer depends on whether
  // both endpoints actually answered.
  if (searchR.status === "rejected") throw searchR.reason;
  if (getR.status === "rejected") throw getR.reason;
  return null;
}

async function lrclibGet(
  p: LrclibParams,
  deadline: Deadline,
): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  if (p.album) url.searchParams.set("album_name", p.album);
  if (p.duration) {
    url.searchParams.set("duration", String(Math.round(p.duration)));
  }
  // Let network errors / 5xx propagate so react-query retries them instead
  // of caching a transient failure as a permanent "no lyrics" for an hour.
  // A 404 is a genuine miss and correctly resolves to null.
  const r = await lyricsFetch(url.toString(), deadline, await headers());
  if (r.status === 404) return null;
  if (!r.ok) throwForStatus(r.status, "LRCLIB /get");
  return (await r.json()) as LrclibRecord;
}

async function lrclibSearch(
  p: LrclibParams,
  deadline: Deadline,
): Promise<LrclibRecord[]> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  // Album is deliberately NOT sent. Measured: the right album leaves the
  // result count unchanged, a wrong one drops it to zero, and YTM and
  // LRCLIB disagree about albums constantly (compilations, regional
  // releases, single vs album). /get already uses it, where strictness is
  // the point and this is the fallback.
  const r = await lyricsFetch(url.toString(), deadline, await headers());
  if (!r.ok) throwForStatus(r.status, "LRCLIB /search");
  const results = (await r.json()) as LrclibRecord[];
  // Every record goes to the scorer. The old code pre-filtered to records
  // having synced lyrics, which empties the result set for tracks whose
  // only correct records are plain, and on a generic title concentrates
  // the survivors onto strangers.
  return Array.isArray(results) ? results : [];
}

function mapRecord(
  r: LrclibRecord,
  suppressSynced = false,
): Lyrics | null {
  if (r.instrumental) {
    return { kind: "plain", text: "🎵 Instrumental", source: "LRCLIB" };
  }
  if (
    !suppressSynced &&
    typeof r.syncedLyrics === "string" &&
    r.syncedLyrics.trim()
  ) {
    const lines = parseLRC(r.syncedLyrics);
    if (lines.length > 0) {
      return { kind: "timed", lines, source: "LRCLIB" };
    }
  }
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim()) {
    return { kind: "plain", text: r.plainLyrics, source: "LRCLIB" };
  }
  return null;
}

