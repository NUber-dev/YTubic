import type { Lyrics } from "@/lib/lyrics/types";
import { parseLRC } from "@/lib/lyrics/parse-lrc";
import { hitMatches, normalizeForMatch } from "@/lib/lyrics/match";

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
  // re-master / live version. `get ?? search` enforces that order.
  const [get, search] = await Promise.all([
    p.artist ? lrclibGet(p) : Promise.resolve(null),
    lrclibSearch(p),
  ]);
  const rec = get ?? search;
  return rec ? mapRecord(rec) : null;
}

async function lrclibGet(p: LrclibParams): Promise<LrclibRecord | null> {
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
  const r = await fetch(url.toString());
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`LRCLIB /get ${r.status}`);
  return (await r.json()) as LrclibRecord;
}

async function lrclibSearch(p: LrclibParams): Promise<LrclibRecord | null> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", p.title);
  if (p.artist) url.searchParams.set("artist_name", p.artist);
  // As in lrclibGet: propagate transient failures for retry; only an empty
  // result set is a genuine "not found".
  const r = await fetch(url.toString());
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
  // Prefer results with synced lyrics. Then, if we know the duration,
  // prefer the closest one — YTM and LRCLIB versions occasionally
  // differ by a second or two.
  const synced = matched.filter((r) => r.syncedLyrics);
  const pool = synced.length > 0 ? synced : matched;
  if (!p.duration) return pool[0];
  return pool.reduce((best, cur) => {
    const bestDiff = Math.abs((best.duration ?? 0) - (p.duration ?? 0));
    const curDiff = Math.abs((cur.duration ?? 0) - (p.duration ?? 0));
    return curDiff < bestDiff ? cur : best;
  });
}

function mapRecord(r: LrclibRecord): Lyrics | null {
  if (r.instrumental) {
    return { kind: "plain", text: "🎵 Instrumental", source: "LRCLIB" };
  }
  if (typeof r.syncedLyrics === "string" && r.syncedLyrics.trim()) {
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

