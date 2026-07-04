import { fetchSearch } from "./search";
import type { SourceKind } from "@/lib/store/track-source";

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
