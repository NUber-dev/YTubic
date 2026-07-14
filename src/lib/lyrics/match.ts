/**
 * Pure text-matching helpers used to verify a lyrics search hit actually
 * corresponds to the requested track. Genius search is fuzzy and almost
 * always returns *something*, so without a similarity check the first hit
 * for a track Genius lacks is a confidently-wrong different song.
 *
 * Kept dependency-free (no Tauri imports) so it's unit-testable.
 */

/** Normalize a title/artist for fuzzy comparison: drop parentheticals,
 *  featurings, and punctuation; lowercase; collapse whitespace. */
/** Like normalizeForMatch but KEEPS parenthetical qualifiers (remix,
 *  live, acoustic...) as plain tokens. Two records that collapse to
 *  the same stripped title — "Die For You" vs "Die For You (Remix)" —
 *  stay distinguishable here, so version picks don't ride on a 1s
 *  duration difference. */
export function normalizeKeepingQualifiers(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bfeat\.?\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\bfeat\.?\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Jaccard similarity: shared tokens over the UNION of both sets (0..1).
 *  Using the union (not the smaller set) is deliberate: a min-denominator
 *  ratio scores a subset as a perfect match, so "Sukha, Prodgk & Tegi Pannu"
 *  vs a different song credited to just "Sukha" would read 1.0 on the one
 *  shared name and let a completely different track's lyrics through. */
export function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/** One normalized string contains the other, but only when the contained
 *  side is long enough to be meaningful. Guards against a short generic hit
 *  title (e.g. "sight") passing as a substring of "on sight". */
function meaningfulContains(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.includes(shorter);
}

/** Both durations known and within `tolSec` of each other. Used to gate
 *  exact-title hits when the requesting track carries no artist metadata
 *  (video uploads often don't): a title alone is not identity — any
 *  popular title is shared by a dozen unrelated songs — so the duration
 *  has to vouch for the match instead. */
export function durationMatches(
  reqSec: number | undefined,
  hitSec: number | undefined,
  tolSec = 4,
): boolean {
  if (!reqSec || !hitSec) return false;
  return Math.abs(reqSec - hitSec) <= tolSec;
}

/** Does a search hit plausibly match the requested track? Title must match;
 *  artist agreement is enforced only when both sides are known. */
export function hitMatches(
  reqTitle: string,
  reqArtist: string,
  hitTitle: string,
  hitArtist: string,
): boolean {
  if (!hitTitle) return false;
  const titleExact = reqTitle === hitTitle;
  const titleOk =
    titleExact ||
    meaningfulContains(hitTitle, reqTitle) ||
    tokenOverlap(reqTitle, hitTitle) >= 0.6;
  if (!titleOk) return false;
  if (!reqArtist || !hitArtist) return true;
  const artistOk =
    meaningfulContains(hitArtist, reqArtist) || tokenOverlap(reqArtist, hitArtist) >= 0.5;
  if (artistOk) return true;
  // Collab tracks are often credited to only the primary artist in a lyric
  // DB. When the title matches exactly, accept a partial artist overlap (the
  // requested primary/any artist appears in the hit) rather than demanding
  // the full collaborator list. A different song by a same-named artist is
  // still rejected here because its title won't match exactly.
  return titleExact && tokenOverlap(reqArtist, hitArtist) > 0;
}
