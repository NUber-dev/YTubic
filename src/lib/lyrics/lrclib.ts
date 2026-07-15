import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import {
  durationMatches,
  hitMatches,
  normalizeForMatch,
  normalizeKeepingQualifiers,
} from "@/lib/lyrics/match";

/**
 * LRCLIB (https://lrclib.net) — free, open lyrics database with synced
 * LRC-format lyrics. CORS is wide-open so we use the webview's plain
 * fetch, no Rust HTTP capability needed.
 */

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
  // re-master / live version. But a synced record beats a plain one
  // regardless of endpoint: LRCLIB carries duplicate rows for the same
  // song (artist credited alone vs with features), and /get exact-
  // matching the plain-only duplicate must not shadow the synced
  // sibling /search found (Bewajah — Abdul Hannan vs "Abdul Hannan,
  // Alan Sampson").
  // allSettled, not all: one endpoint 5xx-ing must not throw away the
  // other's perfectly good record. Only when NO record came back does a
  // failure propagate (so react-query retries instead of caching a
  // transient outage as "no lyrics" for an hour).
  const [getRes, searchRes] = await Promise.allSettled([
    p.artist ? lrclibGet(p, signal) : Promise.resolve(null),
    lrclibSearch(p, signal),
  ]);
  const get = getRes.status === "fulfilled" ? getRes.value : null;
  const search = searchRes.status === "fulfilled" ? searchRes.value : null;
  const rec =
    (get?.syncedLyrics ? get : null) ??
    (search?.syncedLyrics ? search : null) ??
    get ??
    search;
  if (!rec) {
    if (getRes.status === "rejected") throw getRes.reason;
    if (searchRes.status === "rejected") throw searchRes.reason;
  }
  return rec ? mapRecord(rec, p.duration) : null;
}

async function lrclibGet(
  p: LrclibParams,
  signal?: AbortSignal,
): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  if (p.album) url.searchParams.set("album_name", p.album);
  if (p.duration) {
    url.searchParams.set("duration", String(Math.round(p.duration)));
  }
  // Let network errors / 5xx / timeouts propagate so react-query retries
  // them instead of caching a transient failure as a permanent "no
  // lyrics" for an hour. A 404 is a genuine miss and correctly resolves
  // to null.
  const r = await fetch(url.toString(), { signal });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`LRCLIB /get ${r.status}`);
  return (await r.json()) as LrclibRecord;
}

async function lrclibSearch(
  p: LrclibParams,
  signal?: AbortSignal,
): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  // As in lrclibGet: propagate transient failures for retry; only an empty
  // result set is a genuine "not found".
  const r = await fetch(url.toString(), { signal });
  if (!r.ok) throw new Error(`LRCLIB /search ${r.status}`);
  const results = (await r.json()) as LrclibRecord[];
  if (!Array.isArray(results) || results.length === 0) return null;
  // /search is fuzzy and will confidently return a completely different
  // song when LRCLIB has no record for this track (the wrong-lyrics bug).
  // Drop hits whose title/artist don't plausibly match the request before
  // any synced/duration preference runs.
  const reqTitle = normalizeForMatch(p.title);
  const reqArtist = normalizeForMatch(p.artist ?? "");
  const matched = results.filter((rec) =>
    hitMatches(
      reqTitle,
      reqArtist,
      normalizeForMatch(rec.trackName ?? ""),
      normalizeForMatch(rec.artistName ?? ""),
    ),
  );
  if (matched.length === 0) return null;
  // A bare title is not identity. When the request carries no artist
  // (video uploads often have empty metadata), hitMatches waves through
  // any exact-title hit, so "Bittersweet" by one artist happily returns
  // some other Bittersweet's lyrics. Make the duration vouch for the
  // match instead — and with no duration to check either, prefer no
  // lyrics over confidently-wrong ones.
  const verified = reqArtist
    ? matched
    : matched.filter((rec) => durationMatches(p.duration, rec.duration));
  if (verified.length === 0) return null;
  // Prefer results with synced lyrics. Then prefer titles that match
  // WITH qualifiers intact: normalizeForMatch strips parentheticals,
  // so "Die For You" and "Die For You (Remix)" reduce to the same key
  // and the 232s original beat the 233s remix on duration alone —
  // wrong edit's timings on screen. Duration only breaks ties within
  // the same title class.
  const synced = verified.filter((r) => r.syncedLyrics);
  const pool = synced.length > 0 ? synced : verified;
  const qualTitle = normalizeKeepingQualifiers(p.title);
  const scored = pool.map((rec) => ({
    rec,
    exact:
      normalizeKeepingQualifiers(rec.trackName ?? "") === qualTitle ? 0 : 1,
    dDiff: p.duration ? Math.abs((rec.duration ?? 0) - p.duration) : 0,
  }));
  scored.sort((a, b) => a.exact - b.exact || a.dDiff - b.dDiff);
  return scored[0].rec;
}

/**
 * YouTube is full of sped-up / slowed re-uploads, and their LISTED
 * length says exactly how the tempo changed. When the track's length
 * and the lyric record's differ by a consistent factor, rescale every
 * timestamp by that ratio — a constant offset can never fix a tempo
 * change (Heat Waves sped-up: 179s upload vs the 238s original the
 * timings were cut for). Near-1 ratios are left alone (edit/master
 * variance), and extreme ratios mean a different cut entirely.
 */
export function scaleTimedLines(
  lines: TimedLine[],
  recDurationSec: number | undefined,
  targetDurationSec: number | undefined,
): TimedLine[] {
  if (!recDurationSec || !targetDurationSec) return lines;
  if (recDurationSec < 60 || targetDurationSec < 60) return lines;
  const ratio = targetDurationSec / recDurationSec;
  if (Math.abs(ratio - 1) < 0.08 || ratio < 0.6 || ratio > 1.7) return lines;
  return lines.map((l) => ({
    ...l,
    start: l.start * ratio,
    end: l.end !== undefined ? l.end * ratio : undefined,
  }));
}

function mapRecord(r: LrclibRecord, targetDuration?: number): Lyrics | null {
  if (r.instrumental) {
    return { kind: "plain", text: "🎵 Instrumental", source: "LRCLIB" };
  }
  if (typeof r.syncedLyrics === "string" && r.syncedLyrics.trim()) {
    const lines = scaleTimedLines(
      parseLRC(r.syncedLyrics),
      r.duration,
      targetDuration,
    );
    if (lines.length > 0) {
      return {
        kind: "timed",
        lines,
        source: "LRCLIB",
        recordDurationSec: r.duration,
      };
    }
  }
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim()) {
    return { kind: "plain", text: r.plainLyrics, source: "LRCLIB" };
  }
  return null;
}

