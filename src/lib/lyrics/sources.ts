import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import type { Lyrics } from "@/lib/lyrics/types";
import type { QueueTrack } from "@/lib/store/playback";

export type LyricsSource = "lrclib" | "musixmatch" | "genius";

export const SOURCE_ORDER: LyricsSource[] = ["lrclib", "musixmatch", "genius"];

export const SOURCE_LABELS: Record<LyricsSource, string> = {
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
  genius: "Genius",
};

const ONE_HOUR = 60 * 60 * 1000;

/** Per-provider time budget for one fetch attempt. A single dead
 *  provider (stalled TCP, hung extractor endpoint) used to keep its
 *  query in `isLoading` forever — the fetch never resolved, so
 *  `retry: 1` never fired and the panel sat on "Loading lyrics…"
 *  until a track change. The budget covers a provider's WHOLE call
 *  chain (Musixmatch does up to 4 sequential requests), so it's
 *  deliberately roomier than a single-request timeout would be. */
const PROVIDER_TIMEOUT_MS = 8_000;

/** `AbortSignal.timeout` with a fallback for older WebKit — the
 *  controller+setTimeout pair is semantically identical, it just
 *  leaks a timer for the duration instead of cancelling it. */
function lyricsTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("lyrics fetch timed out")), ms);
  return controller.signal;
}

/**
 * Fire both lyric queries in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but Musixmatch has synced LRC, Musixmatch wins.
 *
 * Every provider runs under `PROVIDER_TIMEOUT_MS`, so all three queries
 * are guaranteed to settle (data, null, or error) and the panel always
 * reaches "No lyrics found." instead of hanging on one dead source.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  const artistName =
    track?.artists?.map((a) => a.name).join(", ") ?? track?.subtitle;

  // A bare title is not identity: with no artist line at all, any provider
  // match would rest on the title alone, and popular titles are shared by
  // a dozen unrelated songs (the wrong-Bittersweet bug). Don't query at
  // all — no lyrics beats confidently-wrong lyrics. The providers keep
  // their own artist-less duration gates as a second layer for any other
  // caller.
  const verifiable = !!artistName?.trim();

  // v2: matching semantics changed (artist-less tracks are no longer
  // looked up), so bump the keys to orphan persisted v1 entries that may
  // hold a wrong-song match.
  const lrclib = useQuery({
    queryKey: [
      "lyrics",
      "lrclib-v2",
      track?.title,
      artistName,
      track?.album,
      track?.duration,
    ],
    queryFn: () =>
      fetchLrclibLyrics(
        {
          title: track!.title,
          artist: artistName,
          album: track?.album,
          duration: track?.duration,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const musixmatch = useQuery({
    queryKey: [
      "lyrics",
      "musixmatch-v2",
      track?.title,
      artistName,
      track?.duration,
    ],
    queryFn: () =>
      fetchMusixmatchLyrics(
        {
          title: track!.title,
          artist: artistName,
          duration: track?.duration,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const genius = useQuery({
    queryKey: ["lyrics", "genius-v2", track?.title, artistName],
    queryFn: () =>
      fetchGeniusLyrics(
        {
          title: track!.title,
          artist: artistName,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const queries: Record<LyricsSource, UseQueryResult<Lyrics | null>> = {
    lrclib,
    musixmatch,
    genius,
  };

  let best: LyricsSource | null = null;
  for (const s of SOURCE_ORDER) {
    if (queries[s].data?.kind === "timed") {
      best = s;
      break;
    }
  }
  if (!best) {
    for (const s of SOURCE_ORDER) {
      if (queries[s].data?.kind === "plain") {
        best = s;
        break;
      }
    }
  }

  const isLoading = SOURCE_ORDER.some((s) => queries[s].isLoading);

  return { queries, best, isLoading };
}
