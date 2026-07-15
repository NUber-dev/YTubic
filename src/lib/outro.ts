/**
 * Long-outro auto-advance decision. Extended uploads and music-video
 * audio often run minutes past the actual song (looped beats, credits,
 * dead instrumental) — when synced lyrics say the vocals ended long
 * ago, skip ahead instead of playing filler.
 *
 * Pure so it's unit-testable; the audio engine feeds it live values.
 */

/** Ignore tails shorter than this — normal instrumental outros are
 *  part of the song (e.g. a ~70s fade) and must keep playing. */
export const OUTRO_TAIL_MIN_S = 120;

/** How long after the last sung line playback is allowed to run before
 *  advancing, when the tail qualifies. Generous enough for a real
 *  musical wind-down, short enough to not feel stuck. */
export const OUTRO_GRACE_S = 60;

export function shouldSkipOutro(
  positionSec: number,
  durationSec: number,
  lastVocalSec: number | null,
): boolean {
  if (!lastVocalSec || durationSec <= 0) return false;
  // Sanity: lyrics that claim to end after the file are mismatched.
  if (lastVocalSec >= durationSec) return false;
  if (durationSec - lastVocalSec <= OUTRO_TAIL_MIN_S) return false;
  return positionSec >= lastVocalSec + OUTRO_GRACE_S;
}

/**
 * WKWebView (AVFoundation) reads yt-dlp's un-remuxed DASH m4a headers
 * at exactly DOUBLE the real length (yt-dlp normally repairs these with
 * ffmpeg, which we don't ship; Chromium reads the sample tables and is
 * fine — this is macOS-only). The real audio plays 1:1 and the phantom
 * second half is silence. When the element's claim is ~2x the entry's
 * own listed length, the listed length is the truth.
 */
export function correctedDuration(
  metaSec: number | undefined,
  elementSec: number,
): number {
  if (!metaSec || metaSec < 30) return elementSec;
  const ratio = elementSec / metaSec;
  if (ratio > 1.8 && ratio < 2.2) return metaSec;
  return elementSec;
}
