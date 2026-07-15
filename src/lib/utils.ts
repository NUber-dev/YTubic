import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * YTM subtitles are often a decorated metadata line ("Song • Don Toliver
 * • 3:47", "3.4M views • 2 years ago") rather than a plain artist.
 * Tracks played from those surfaces carry no structured `artists`, so
 * every consumer that falls back to the subtitle (lyrics lookup, Now
 * Playing, scrobbles, notifications) ends up searching for an "artist"
 * named "Song • Don Toliver • 3:47" and finding nothing.
 *
 * Split on the bullet, drop the segments that are provably not an artist
 * (type tokens, durations, years, view counts), and return the first
 * survivor, which is where YTM puts the artist. Returns "" when nothing
 * artist-like remains; callers should treat that as "no artist known"
 * (for lyrics that correctly means: don't guess).
 */
const SUBTITLE_JUNK =
  /^(song|video|album|single|ep|playlist|artist|episode|podcast|profile)$|^\d+:\d+(:\d+)?$|^\d{4}$|(views|plays|likes|subscribers|monthly listeners)$|ago$|^explicit$/i;

export function artistLineFromSubtitle(subtitle: string | undefined): string {
  if (!subtitle) return "";
  if (!subtitle.includes("•")) return subtitle.trim();
  const kept = subtitle
    .split("•")
    .map((s) => s.trim())
    .filter((s) => s && !SUBTITLE_JUNK.test(s));
  return kept[0] ?? "";
}
