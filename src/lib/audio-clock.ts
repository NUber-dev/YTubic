let source: HTMLAudioElement | null = null;

export function setAudioClockSource(el: HTMLAudioElement | null): void {
  source = el;
}

/**
 * The playing element's own currentTime, for anything that has to stay in
 * step with the audio frame-by-frame.
 *
 * The playback store's `position` is written from `timeupdate`, which
 * Chromium fires about four times a second, so it can sit ~250ms behind
 * the real clock. That's fine for a progress bar and useless for keeping
 * a video aligned.
 */
export function getAudioClock(): number | null {
  if (!source || !source.src) return null;
  return source.currentTime;
}
