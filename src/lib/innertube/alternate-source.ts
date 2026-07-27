import { fetchSearch } from "./search";
import { fetchRadio } from "./radio";
import { normalizeForMatch, normalizeKeepingQualifiers, tokenOverlap } from "@/lib/lyrics/match";
import type { SourceKind } from "@/lib/store/track-source";
import type { MinimalArtist, ShelfItemKind } from "./types";

/**
 * Find the alternate-source videoId for a track by searching YT Music
 * with the opposite kind filter. Every candidate must pass identity
 * gates before we accept it — trusting YT's relevance ranking alone
 * played completely unrelated clips for title collisions (a 2:49
 * "Dilbar" remix toggled into the 15:54 Bollywood "Dilbar"). Same
 * discipline as the lyrics matcher and the clean-audio hunt: the title
 * must actually match, the artists must overlap when both sides name
 * them, and the duration must be in the plausible window for a
 * song<->video counterpart. No match beats a wrong match — the toggle
 * shows "No video version found" on null.
 *
 * Also used to play the uncensored / original audio when YT Music's
 * "song" version is the censored one (common for Russian artists
 * working around the local lyric ban).
 */
export async function findAlternateVideoId(
  track: {
    videoId: string;
    title: string;
    artists?: MinimalArtist[];
    duration?: number;
  },
  targetKind: SourceKind,
): Promise<string | null> {
  const artistsLine = track.artists?.map((a) => a.name).join(" ") ?? "";
  const query = `${track.title} ${artistsLine}`.trim();
  if (!query) return null;
  const filter = targetKind === "video" ? "videos" : "songs";
  const results = await fetchSearch(query, filter);
  const reqTitle = normalizeForMatch(track.title);
  const reqArtists = normalizeForMatch(artistsLine);

  const passes = (item: {
    kind: ShelfItemKind;
    id: string;
    title: string;
    artists?: MinimalArtist[];
    duration?: number;
  }): boolean => {
    if (item.kind !== "song" && item.kind !== "video") return false;
    if (item.id === track.videoId) return false;

    const hitTitle = normalizeForMatch(item.title ?? "");
    let titleExact = hitTitle === reqTitle;
    if (titleExact) {
      // normalizeForMatch strips parenthetical qualifiers, so "Song (Remix)"
      // and "Song" look identical to it. The qualifier-preserving form must
      // agree too, or the "exact" match is a different version of the song.
      titleExact =
        normalizeKeepingQualifiers(item.title ?? "") ===
        normalizeKeepingQualifiers(track.title);
    }
    if (!titleExact && tokenOverlap(reqTitle, hitTitle) < 0.6) return false;

    if (reqArtists && item.artists?.length) {
      const hitArtists = normalizeForMatch(
        item.artists.map((a) => a.name).join(" "),
      );
      if (tokenOverlap(reqArtists, hitArtists) === 0) return false;
    }

    // Duration window: a music video runs a little longer than the album
    // audio (intro/outro), the song side a little shorter. Never accept a
    // counterpart in a different league (compilations, hour loops, clips).
    if (track.duration && item.duration) {
      const delta = item.duration - track.duration;
      if (targetKind === "video") {
        if (delta < -45 || delta > 240) return false;
      } else {
        if (delta < -240 || delta > 45) return false;
      }
    } else if (!titleExact) {
      // No duration to vouch and the title only fuzzy-matches: too risky.
      return false;
    }
    return true;
  };

  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (passes(item)) return item.id;
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
  const reqArtists = normalizeForMatch(artistsLine);
  const passes = (item: {
    kind: ShelfItemKind;
    id: string;
    title: string;
    artists?: MinimalArtist[];
    duration?: number;
  }): boolean => {
    if (item.kind !== "song") return false;
    if (item.id === track.videoId) return false;
    const hitTitle = normalizeForMatch(item.title ?? "");
    if (hitTitle !== reqTitle && tokenOverlap(reqTitle, hitTitle) < 0.6) {
      return false;
    }
    if (item.artists?.length) {
      const hitArtists = normalizeForMatch(
        item.artists.map((a) => a.name).join(" "),
      );
      if (tokenOverlap(reqArtists, hitArtists) === 0) return false;
    }
    return cleanAudioSwapOk(track.kind, track.duration, item.duration);
  };
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (passes(item)) return item.id;
    }
  }
  // Search often surfaces only the canonical entry (which for some songs
  // IS the extended album cut). The track's own radio reliably lists the
  // other uploads of the same song — the shorter album/single version
  // shows up there when search hides it. Same gates apply.
  try {
    const radio = await fetchRadio(track.videoId);
    for (const item of radio) {
      if (passes(item)) return item.id;
    }
  } catch {
    /* radio is best-effort — no swap is fine */
  }
  return null;
}
