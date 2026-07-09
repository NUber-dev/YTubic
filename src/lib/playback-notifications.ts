import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentTrack, usePlaybackStore } from "@/lib/store/playback";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * System toast on track change (Settings → General → Playback
 * notifications). Mounted once in AppShell — playback state lives in
 * the main window, so this is the only place a change can originate.
 *
 * The "is the user already looking at the app?" suppression lives in
 * the Rust `notify_track` command, where every window's focus state is
 * visible — toasts only show while YTubic sits in the background or
 * the tray.
 */
export function usePlaybackNotifications(): void {
  const enabled = useSettingsStore((s) => s.playbackNotifications);
  const track = usePlaybackStore(currentTrack);
  const videoId = track?.videoId ?? null;
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    if (videoId === null) {
      // Queue cleared / nothing playing — reset so the next track
      // (even a replay of the same id) notifies again.
      lastSeenRef.current = null;
      return;
    }
    const prev = lastSeenRef.current;
    // Track the id even while the setting is off: flipping the toggle
    // mid-song shouldn't retroactively toast the current track.
    lastSeenRef.current = videoId;
    if (!enabled || prev === videoId) return;

    const artists =
      track?.artists?.map((a) => a.name).join(", ") ||
      track?.subtitle ||
      "";
    invoke("notify_track", {
      title: track?.title ?? "Now playing",
      body: artists,
    }).catch(() => {
      /* best-effort: plain-vite dev or toast backend failure */
    });
  }, [videoId, enabled, track]);
}
