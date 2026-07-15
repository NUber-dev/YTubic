import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * Shared Last.fm helpers used by both the scrobbler (`lastfm-scrobbler.ts`)
 * and the loved-track sync wired into the like buttons. The signed API calls
 * and the offline retry queue live in `src-tauri/src/lastfm.rs`.
 */

/** Minimal track shape these helpers need. Both `QueueTrack` (playback store)
 *  and `ShelfItem` (browse results) satisfy it structurally. */
export type LastfmTrackMeta = {
  title?: string;
  artists?: { name: string }[];
  subtitle?: string;
  album?: string;
};

/**
 * The artist string Last.fm should see. Joins the structured artist names (or
 * falls back to the subtitle) and strips YouTube Music's " - Topic" channel
 * suffix, which auto-generated artist channels carry and which would otherwise
 * pollute the scrobble / loved track.
 */
export function lastfmArtist(track: LastfmTrackMeta | undefined): string {
  if (!track) return "";
  const raw = track.artists?.length
    ? track.artists.map((a) => a.name).join(", ")
    : (track.subtitle ?? "");
  return raw.replace(/\s*-\s*Topic$/i, "").trim();
}

/**
 * Mirror a YouTube Music like/unlike to the connected Last.fm account as a
 * loved / unloved track. No-op unless Last.fm is connected and the loved-track
 * sync is switched on (a separate opt-in from scrobbling). Best-effort: love
 * state isn't queued for retry (unlike scrobbles), so an offline like just
 * isn't mirrored.
 */
export function syncLastfmLove(
  track: LastfmTrackMeta | undefined,
  loved: boolean,
): void {
  const { lastfmLoveSync, lastfmSessionKey } = useSettingsStore.getState();
  if (!lastfmLoveSync || !lastfmSessionKey) return;
  const artist = lastfmArtist(track);
  const title = track?.title?.trim() ?? "";
  if (!artist || !title) return;
  void invoke("lastfm_love", {
    artist,
    track: title,
    loved,
    sessionKey: lastfmSessionKey,
  }).catch(() => {
    /* best-effort; love isn't retried */
  });
}
