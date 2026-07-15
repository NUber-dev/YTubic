import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlaybackStore } from "@/lib/store/playback";
import { useSettingsStore } from "@/lib/store/settings";
import { lastfmArtist } from "@/lib/lastfm";

/**
 * Last.fm scrobbling timing. The signed API calls + the offline retry queue
 * live in `src-tauri/src/lastfm.rs`; this hook owns the *when*:
 *
 *   * on a track change it announces "now playing", and
 *   * it accrues real listening time (paused time doesn't count) and fires a
 *     scrobble the moment a track crosses Last.fm's eligibility bar: played
 *     for at least half its length or 4 minutes, whichever comes first, and
 *     never for tracks shorter than 30 seconds.
 *
 * Mounted once in AppShell next to the other playback-reactive hooks. Reads
 * track metadata imperatively (like the audio engine) so a late title/artwork
 * refresh can't re-fire the effects and reset the accrued play time.
 *
 * Known v1 limitation: a track repeated back-to-back (repeat-one) keeps the
 * same queue slot, so the replay isn't scrobbled again, only the first play.
 */

// Scrobble at 50% of the track or this many seconds, whichever is sooner.
const SCROBBLE_CAP_SECONDS = 240;
// Last.fm ignores tracks shorter than this.
const MIN_TRACK_SECONDS = 30;

type TrackTiming = {
  videoId: string;
  /** Unix seconds when the track started. Last.fm scrobbles are timestamped
   *  with the start time, not the moment the threshold is crossed. */
  startedAt: number;
  /** Accrued real listening time. */
  playedMs: number;
  scrobbled: boolean;
};

function durationSeconds(d: number): number {
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function useLastfmScrobbler(): void {
  const enabled = useSettingsStore((s) => s.lastfmEnabled);
  const sessionKey = useSettingsStore((s) => s.lastfmSessionKey);
  const active = enabled && !!sessionKey;

  const videoId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
  );
  const playing = usePlaybackStore((s) => s.playing);

  const timingRef = useRef<TrackTiming | null>(null);

  // New track (or the integration just became active): reset the play-time
  // counter and announce "now playing". Duration is omitted here: the real
  // value isn't loaded yet at track start, and a wrong one is worse than none.
  useEffect(() => {
    if (!active || !videoId || !sessionKey) {
      timingRef.current = null;
      return;
    }
    const s = usePlaybackStore.getState();
    const t = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!t) {
      timingRef.current = null;
      return;
    }
    timingRef.current = {
      videoId,
      startedAt: Math.floor(Date.now() / 1000),
      playedMs: 0,
      scrobbled: false,
    };
    void invoke("lastfm_update_now_playing", {
      artist: lastfmArtist(t),
      track: t.title,
      album: t.album ?? "",
      duration: null,
      sessionKey,
    }).catch(() => {
      /* best-effort; now-playing is ephemeral on Last.fm's side */
    });
  }, [videoId, active, sessionKey]);

  // While playing, accrue a second at a time and scrobble once the threshold is
  // crossed. Pausing tears the interval down (deps include `playing`), so the
  // counter reflects actual listening rather than wall-clock.
  useEffect(() => {
    if (!active || !playing) return;
    const id = window.setInterval(() => {
      const timing = timingRef.current;
      if (!timing || timing.scrobbled) return;

      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      // Only count toward the track this timing belongs to.
      if (!t || t.videoId !== timing.videoId) return;

      timing.playedMs += 1000;

      const dur = durationSeconds(s.duration);
      if (dur > 0 && dur < MIN_TRACK_SECONDS) return; // too short to scrobble
      const thresholdSec =
        dur > 0 ? Math.min(dur / 2, SCROBBLE_CAP_SECONDS) : SCROBBLE_CAP_SECONDS;
      if (timing.playedMs / 1000 < thresholdSec) return;

      const key = useSettingsStore.getState().lastfmSessionKey;
      if (!key) return;
      timing.scrobbled = true;
      void invoke("lastfm_scrobble", {
        artist: lastfmArtist(t),
        track: t.title,
        album: t.album ?? "",
        duration: dur > 0 ? Math.round(dur) : null,
        timestamp: timing.startedAt,
        sessionKey: key,
      }).catch(() => {
        /* transport failures are queued for retry on the Rust side */
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, playing]);

  // Drain scrobbles stranded offline. Rust also flushes once at startup; this
  // additionally covers enabling the integration mid-session.
  useEffect(() => {
    if (!active) return;
    void invoke("lastfm_flush").catch(() => {});
  }, [active]);
}
