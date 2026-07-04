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

/**
 * Fire both lyric queries in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but Musixmatch has synced LRC, Musixmatch wins.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  const artistName =
    track?.artists?.map((a) => a.name).join(", ") ?? track?.subtitle;

  const lrclib = useQuery({
    queryKey: [
      "lyrics",
      "lrclib",
      track?.title,
      artistName,
      track?.album,
      track?.duration,
    ],
    queryFn: () =>
      fetchLrclibLyrics({
        title: track!.title,
        artist: artistName,
        album: track?.album,
        duration: track?.duration,
      }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const musixmatch = useQuery({
    queryKey: ["lyrics", "musixmatch", track?.title, artistName],
    queryFn: () =>
      fetchMusixmatchLyrics({
        title: track!.title,
        artist: artistName,
      }),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: 1,
  });

  const genius = useQuery({
    queryKey: ["lyrics", "genius", track?.title, artistName],
    queryFn: () =>
      fetchGeniusLyrics({
        title: track!.title,
        artist: artistName,
      }),
    enabled: !!track && enabled,
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
