import {
  artistScore,
  durationScore,
  lastTimestamp,
  normalizeForScore,
  parseTitle,
  qualifierFactor,
  titleIdentity,
  type ParsedTitle,
} from "@/lib/lyrics/match";
import { cleanTrackTitle } from "@/lib/track-meta";

/**
 * Deciding which search hit is the track we asked for.
 *
 * Replaces a boolean that only one of three providers even consulted, and
 * that answered "yes" for a remix of the right song, for a stranger's song
 * with the same title, and for a hit credited to one artist out of three.
 *
 * The shape of the answer is a product, not a sum. Scoring title, artist
 * and duration independently and adding them dilutes the only informative
 * term: for "Levitating" the title term is 1.00 and the duration term ~1.00
 * for every candidate, so an additive score is decided by noise. A product
 * lets any single axis veto.
 */

export type ScoreQuery = {
  /** Already through `cleanTrackTitle`. */
  title: string;
  artist?: string;
  durationSec?: number;
  /**
   * True when this candidate set came from re-querying without the artist.
   * Nothing from such a set may be used: dropping the artist for
   * Marshmello's "Alone" surfaces Parkway Drive's unrelated metalcore track
   * at a near-identical duration, with synced lyrics, scoring perfectly.
   */
  artistWasDropped?: boolean;
};

export type ScoreCandidate = {
  trackName?: string;
  artistName?: string;
  duration?: number | null;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
};

export type Verdict = {
  score: number;
  reject: boolean;
  reason: string;
  /**
   * The synced body exists but runs past the end of the audio. The record
   * is still the right song; its timings are not usable.
   */
  suppressSynced: boolean;
};

export type ScoreOptions = {
  /**
   * The provider cannot report candidate durations (Musixmatch search,
   * Genius). Duration stops discriminating instead of pretending to.
   */
  durationBlind?: boolean;
  /** Minimum score to accept. Higher when a provider has fewer signals. */
  floor?: number;
  /**
   * The body has not been fetched yet, so its presence cannot be checked.
   * Musixmatch and Genius decide which track to fetch from search metadata
   * alone; only LRCLIB returns the lyrics inline with the candidates.
   */
  bodyUnknown?: boolean;
};

/** Below this, return no match rather than the best of a bad set. */
export const DEFAULT_FLOOR = 0.55;
/** Musixmatch and Genius have no duration, so one fewer axis can veto. */
export const DURATION_BLIND_FLOOR = 0.7;

const IDENTITY_FLOOR = 0.85;
const ARTIST_FLOOR = 0.45;
const CROSS_SCRIPT_ARTIST_FLOOR = 0.85;
/** Overhang past the audio that marks an LRC as belonging to a longer cut. */
const OVERHANG_TOLERANCE_S = 5;
/** A candidate this much longer than the audio cannot be the same cut. */
const MAX_LENGTH_RATIO = 1.6;

function hasBody(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim() !== "";
}

function usableDuration(d: number | null | undefined): number | undefined {
  // Junk durations (3s, 30s, 694s) sit on records carrying complete correct
  // bodies. Drop the duration, not the record.
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : undefined;
}

export function scoreCandidate(
  q: ScoreQuery,
  c: ScoreCandidate,
  opts: ScoreOptions = {},
): Verdict {
  const no = (reason: string): Verdict => ({
    score: 0,
    reject: true,
    reason,
    suppressSynced: false,
  });

  // R2. An artist-less retry of a query that had an artist is never usable.
  if (q.artistWasDropped) return no("artist was dropped from the query");

  // R1. Test for a non-empty string, not for truthiness: three of the
  // highest-scoring 밤편지 rows carry syncedLyrics: "" and plainLyrics: "".
  const synced = hasBody(c.syncedLyrics);
  const plain = hasBody(c.plainLyrics);
  if (!opts.bodyUnknown && !synced && !plain && c.instrumental !== true) {
    return no("empty body");
  }

  const qTitle = parseTitle(cleanTrackTitle(q.title), q.artist);
  // The candidate title gets the same cleanup as ours: LRCLIB stores rows
  // like "Marshmello - Alone (Official Music Video)", which is a correct
  // record scoring 0.22 raw and 1.000 once cleaned.
  const cTitle = parseTitle(cleanTrackTitle(c.trackName ?? ""), c.artistName);

  const artistKnown = !!q.artist?.trim() && !!c.artistName?.trim();

  // R3. Title-only matching needs a title with something to distinguish.
  // Bare "On" returns fourteen unrelated songs called On; bare "Stay"
  // returns twelve, all of them Taylor Swift's "Stay Stay Stay".
  if (!artistKnown && !titleIsDistinctive(qTitle)) {
    return no("title too generic to match without an artist");
  }

  const identity = titleIdentity(qTitle, cTitle);
  const crossScript = identity === 0;

  const aScore = artistKnown
    ? artistScore(q.artist!, c.artistName!, durationDelta(q, c))
    : 0;

  if (crossScript) {
    // No shared characters is uninformative rather than negative:
    // "Группа крови" and "Gruppa Krovi" are the same recording. But then
    // the artist has to carry the whole decision alone.
    if (!artistKnown || aScore < CROSS_SCRIPT_ARTIST_FLOOR) {
      return no("different script and the artist does not carry it");
    }
  } else if (identity < IDENTITY_FLOOR) {
    return no(`title identity ${identity.toFixed(3)} below floor`);
  }

  if (artistKnown && aScore < ARTIST_FLOOR) {
    return no(`artist score ${aScore.toFixed(3)} below floor`);
  }

  const cDur = usableDuration(c.duration);
  const delta = durationDelta(q, c);

  // R8. One-sided on purpose. A candidate longer than the audio guarantees
  // overhang; a candidate shorter does not, and a symmetric bound rejects
  // Thriller's only correct record against the long-form video.
  if (!opts.durationBlind && cDur && q.durationSec && cDur > q.durationSec * MAX_LENGTH_RATIO) {
    return no(`candidate ${Math.round(cDur)}s far longer than the audio`);
  }

  // R7. The one claim a record makes that can be checked against itself.
  // A fifth of probed synced records overrun their own stored duration.
  let suppressSynced = false;
  if (synced && q.durationSec) {
    const last = lastTimestamp(c.syncedLyrics);
    if (last !== null && last > q.durationSec + OVERHANG_TOLERANCE_S) {
      // Right song, unusable timings. Keep the record only if it can still
      // answer in plain text.
      if (!plain) return no("synced lyrics run past the end of the audio");
      suppressSynced = true;
    }
  }

  const usableSynced = synced && !suppressSynced;
  const dScore = opts.durationBlind
    ? 0.5
    : q.durationSec === undefined
      ? 0.5
      : delta === undefined
        ? 0.3
        : durationScore(delta);

  // Unverified is never as good as verified, but is not disqualifying.
  const artistFactor = artistKnown ? aScore : 0.8;

  let qFactor = qualifierFactor(qTitle, cTitle);
  // Both fields lie for tempo edits: six "(Acoustic)" rows carry the
  // electric length, and "(Sped Up)" rows carry the original. When the tag
  // and the duration disagree, trust neither.
  if (qFactor < 1 && delta !== undefined && Math.abs(delta) <= 3) {
    qFactor *= 0.85;
  }

  const bodyFactor = opts.bodyUnknown || usableSynced ? 1 : 0.92;

  // The envelope caps duration's total influence, so a perfect duration can
  // never outvote an artist mismatch. Drake's "Sticky" and Tyler's are
  // unrelated songs sixteen seconds apart.
  const score =
    (crossScript ? 0.9 : identity) *
    artistFactor *
    qFactor *
    (0.55 + 0.45 * dScore) *
    bodyFactor;

  return {
    score: Math.max(0, Math.min(1, score)),
    reject: false,
    reason: "accepted",
    suppressSynced,
  };
}

function durationDelta(
  q: ScoreQuery,
  c: ScoreCandidate,
): number | undefined {
  const cd = usableDuration(c.duration);
  if (cd === undefined || q.durationSec === undefined) return undefined;
  return Math.round(cd) - Math.round(q.durationSec);
}

function titleIsDistinctive(t: ParsedTitle): boolean {
  const n = normalizeForScore(t.base);
  if (!n) return false;
  const latinTokens = n.split(" ").filter(Boolean);
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(n);
  return hasCjk ? n.replace(/\s/g, "").length >= 3 : latinTokens.length >= 2;
}

export type Selection<T> = {
  record: T;
  verdict: Verdict;
} | null;

/**
 * Pick the best candidate, or none.
 *
 * Grouping by lyric body first is what makes this tractable: twenty rows
 * routinely collapse to one or two distinct bodies, so the real decision is
 * which body, and choosing among clones by duration is theatre.
 */
export function selectBest<T extends ScoreCandidate>(
  q: ScoreQuery,
  candidates: T[],
  opts: ScoreOptions = {},
): Selection<T> {
  if (!candidates?.length) return null;

  const scored = candidates
    .map((record) => ({ record, verdict: scoreCandidate(q, record, opts) }))
    .filter((x) => !x.verdict.reject);
  if (scored.length === 0) return null;

  // R9. With no artist to check against, candidates disagreeing about who
  // performed this means we cannot tell a cover from the original. Bare
  // "Blinding Lights" offers a Teddy Swims cover at 199s against the real
  // track at 200s: a one-second margin, inside LRCLIB's own variance for a
  // single recording. Refuse rather than guess.
  if (!q.artist?.trim()) {
    const artists = new Set(
      scored.map((x) => normalizeForScore(x.record.artistName ?? "")),
    );
    artists.delete("");
    if (artists.size > 1) return null;
  }

  const groups = new Map<string, typeof scored>();
  for (const x of scored) {
    const key = bodyKey(x.record, x.verdict);
    const g = groups.get(key);
    if (g) g.push(x);
    else groups.set(key, [x]);
  }

  let best: (typeof scored)[number] | null = null;
  let bestGroupScore = -1;
  for (const group of groups.values()) {
    const groupScore = Math.max(...group.map((x) => x.verdict.score));
    if (groupScore <= bestGroupScore) continue;
    bestGroupScore = groupScore;
    best = pickWithinGroup(group);
  }

  const floor = opts.floor ?? (opts.durationBlind ? DURATION_BLIND_FLOOR : DEFAULT_FLOOR);
  if (!best || best.verdict.score < floor) return null;
  return best;
}

function bodyKey(c: ScoreCandidate, v: Verdict): string {
  const body = !v.suppressSynced && hasBody(c.syncedLyrics)
    ? c.syncedLyrics!
    : (c.plainLyrics ?? "");
  // Normalizing collapses the punctuation and casing differences between
  // otherwise identical uploads of one transcription.
  return normalizeForScore(body).slice(0, 400);
}

function pickWithinGroup<T extends ScoreCandidate>(
  group: { record: T; verdict: Verdict }[],
): { record: T; verdict: Verdict } {
  // Within one body, prefer the record nearest the group's modal duration
  // rather than nearest the query: the mode is what the crowd agrees this
  // recording is, and it is unambiguous in practice (14 of 20 "bad guy"
  // rows at 194s).
  const counts = new Map<number, number>();
  for (const x of group) {
    const d = usableDuration(x.record.duration);
    if (d === undefined) continue;
    const r = Math.round(d);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let mode: number | undefined;
  let modeCount = 0;
  for (const [d, n] of counts) {
    if (n > modeCount) {
      modeCount = n;
      mode = d;
    }
  }

  const sorted = [...group].sort((a, b) => {
    if (Math.abs(a.verdict.score - b.verdict.score) > 0.02) {
      return b.verdict.score - a.verdict.score;
    }
    if (mode !== undefined) {
      const da = Math.abs((usableDuration(a.record.duration) ?? Infinity) - mode);
      const db = Math.abs((usableDuration(b.record.duration) ?? Infinity) - mode);
      if (da !== db) return da - db;
    }
    const sa = !a.verdict.suppressSynced && hasBody(a.record.syncedLyrics);
    const sb = !b.verdict.suppressSynced && hasBody(b.record.syncedLyrics);
    if (sa !== sb) return sa ? -1 : 1;
    return (b.record.plainLyrics?.length ?? 0) - (a.record.plainLyrics?.length ?? 0);
  });
  return sorted[0];
}
