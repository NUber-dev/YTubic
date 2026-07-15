/**
 * Auto-align lyric timings to uploads with a padded intro.
 *
 * Some uploads are the same recording as the edit the lyric timings
 * were cut for, plus a few seconds of lead-in (channel sting, silence,
 * longer ambient open). A constant shift fixes those completely, and
 * they are exactly the "lyrics fire early on this one song" reports.
 *
 * Detection is deliberately double-gated so it can never hurt a
 * normal track:
 *  1. the file's REAL duration must exceed the lyric record's by a
 *     pad-sized amount (a tail-padded upload also passes this, so it
 *     is not enough on its own), and
 *  2. decoding the head of the actual audio must find the first
 *     sustained energy onset at roughly that same amount in.
 * Only when both point at the same number does the shift apply. A
 * tail-padded upload has onset ~0 and fails gate 2; a clean upload
 * fails gate 1; a different arrangement entirely won't agree on the
 * two numbers.
 */

const PAD_MIN_S = 2.5;
const PAD_MAX_S = 25;
/** How closely the duration surplus and the audio onset must agree. */
const AGREE_TOLERANCE_S = 3;
/** How much of the file head to decode for onset detection. */
const HEAD_BYTES = 1_500_000;
/** RMS window for the energy envelope. */
const WINDOW_S = 0.05;
/** Windows must stay above the threshold this long to count as the
 *  music starting (kills clicks and single transients). */
const SUSTAIN_S = 0.4;

/** Find the first sustained-energy onset in an AudioBuffer, seconds. */
function findOnsetSec(buf: AudioBuffer): number | null {
  const data = buf.getChannelData(0);
  const win = Math.max(1, Math.floor(buf.sampleRate * WINDOW_S));
  const rms: number[] = [];
  for (let i = 0; i + win <= data.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += data[j] * data[j];
    rms.push(Math.sqrt(sum / win));
  }
  if (rms.length === 0) return null;
  const peak = Math.max(...rms);
  if (peak <= 0) return null;
  // 8% of peak separates real program material from noise floor and
  // faded channel stings well enough for a coarse pad estimate.
  const threshold = peak * 0.08;
  const needed = Math.ceil(SUSTAIN_S / WINDOW_S);
  let run = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] >= threshold) {
      run++;
      if (run >= needed) return (i - run + 1) * WINDOW_S;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * Estimate the lead-in pad of `streamUrl` relative to the lyric
 * record. Returns the offset in seconds to ADD to every lyric
 * timestamp (positive = lyrics fire later), or 0 when the signals
 * don't agree that a head pad exists.
 */
export async function estimateLeadInOffset(
  streamUrl: string,
  realDurationSec: number | undefined,
  recordDurationSec: number | undefined,
): Promise<number> {
  if (!realDurationSec || !recordDurationSec) return 0;
  const surplus = realDurationSec - recordDurationSec;
  if (surplus < PAD_MIN_S || surplus > PAD_MAX_S) return 0;
  try {
    const res = await fetch(streamUrl, {
      headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
    });
    if (!res.ok && res.status !== 206) return 0;
    const bytes = await res.arrayBuffer();
    // OfflineAudioContext keeps this off the playback path entirely.
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes);
    const onset = findOnsetSec(buf);
    if (onset === null || onset < PAD_MIN_S) return 0;
    if (Math.abs(onset - surplus) > AGREE_TOLERANCE_S) return 0;
    return onset;
  } catch {
    // Decode failures (partial container the decoder rejects, odd
    // codecs) just mean no auto-alignment for this track.
    return 0;
  }
}
