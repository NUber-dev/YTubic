import { fetchSearch } from "./search";
import { normalizeForMatch, tokenOverlap } from "@/lib/lyrics/match";
import type { SourceKind } from "@/lib/store/track-source";
import type { MinimalArtist, ShelfItemKind } from "./types";

/**
 * Find the alternate-source videoId for a track. Given a song's videoId
 * (and the title / artist line we've got in metadata), search YT Music
 * with the opposite kind filter and pick the first result that isn't
 * the input id. Title/artist match is implicit in YT's relevance
 * ranking — we don't try to fuzzy-match because YT already does that
 * better than we could.
 *
 * Used to play the uncensored / original audio when YT Music's "song"
 * version is the censored one (common for Russian artists working
 * around the local lyric ban — switching to the music-video source
 * gets you the real recording).
 */
export async function findAlternateVideoId(
  query: string,
  currentVideoId: string,
  targetKind: SourceKind,
): Promise<string | null> {
  if (!query.trim()) return null;
  const filter = targetKind === "video" ? "videos" : "songs";
  const results = await fetchSearch(query, filter);
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (item.kind !== "song" && item.kind !== "video") continue;
      if (item.id === currentVideoId) continue;
      return item.id;
    }
  }
  return null;
}

/**
 * Duration sanity for the automatic clean-audio hunt. The manual Song/
 * Video toggle trusts YT's ranking because the user asked for the swap;
 * the AUTO hunt swaps silently, so it must never trade the queued track
 * for something that isn't obviously the same song in its album form.
 *
 * - video uploads: the song version is normally a little shorter (no
 *   intro/outro padding), so accept anything up to slightly longer.
 * - song/unknown rows: only rescue clearly-extended uploads (slowed,
 *   looped, "extended mix" re-uploads) — the album version must be at
 *   least a minute shorter, otherwise leave the queued version alone.
 */
export function cleanAudioSwapOk(
  currentKind: ShelfItemKind | undefined,
  currentDurationSec: number | undefined,
  altDurationSec: number | undefined,
): boolean {
  if (!currentDurationSec || !altDurationSec) return false;
  if (altDurationSec < 60) return false;
  if (currentKind === "video") {
    return altDurationSec <= currentDurationSec + 30;
  }
  return altDurationSec <= currentDurationSec - 60;
}

/**
 * Automatic-hunt variant of `findAlternateVideoId`: find the clean album
 * ("song") version of a queued track, with the title verified against the
 * request and the duration gated by `cleanAudioSwapOk`. Returns null when
 * nothing passes — no swap is always safer than a wrong swap.
 */
export async function findCleanAudioAlternate(track: {
  videoId: string;
  title: string;
  artists?: MinimalArtist[];
  kind?: ShelfItemKind;
  duration?: number;
}): Promise<string | null> {
  const artistsLine = track.artists?.map((a) => a.name).join(" ") ?? "";
  if (!artistsLine.trim() || !track.title.trim()) return null;
  const results = await fetchSearch(
    `${track.title} ${artistsLine}`.trim(),
    "songs",
  );
  const reqTitle = normalizeForMatch(track.title);
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (item.kind !== "song") continue;
      if (item.id === track.videoId) continue;
      const hitTitle = normalizeForMatch(item.title ?? "");
      if (hitTitle !== reqTitle && tokenOverlap(reqTitle, hitTitle) < 0.6) {
        continue;
      }
      if (item.artists?.length) {
        const hitArtists = normalizeForMatch(
          item.artists.map((a) => a.name).join(" "),
        );
        if (tokenOverlap(normalizeForMatch(artistsLine), hitArtists) === 0) {
          continue;
        }
      }
      if (!cleanAudioSwapOk(track.kind, track.duration, item.duration)) {
        continue;
      }
      return item.id;
    }
  }
  return null;
}
