let source: HTMLAudioElement | null = null;

export function setAudioClockSource(el: HTMLAudioElement | null): void {
  source = el;
}

/** Live clock. The store's `position` lags by up to a `timeupdate` tick. */
export function getAudioClock(): number | null {
  if (!source || !source.src) return null;
  return source.currentTime;
}
