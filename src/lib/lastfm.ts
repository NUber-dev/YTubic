import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/lib/store/settings";
import {
  artistFromSubtitle,
  artistsFromList,
  stripTopicSuffix,
} from "@/lib/track-meta";

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
 * The artist string Last.fm should see: the structured artist names, or the
 * subtitle breadcrumb parsed down to a name, with YouTube Music's " - Topic"
 * channel suffix stripped either way.
 *
 * The " - Topic" rule used to live here as its own regex while the lyrics
 * path had no equivalent; both now share `track-meta.ts`, which additionally
 * knows how to read a breadcrumb. That upgrade lands here too: this used to
 * fall back to the raw subtitle, so tracks without structured artists were
 * scrobbled to an "artist" called "Video • The Weeknd • 1B views".
 *
 * The raw fallback is kept as a last resort, so a breadcrumb shape the
 * parser does not recognise still scrobbles exactly as it did before rather
 * than not at all.
 */
export function lastfmArtist(track: LastfmTrackMeta | undefined): string {
  if (!track) return "";
  return (
    artistsFromList(track.artists) ??
    artistFromSubtitle(track.subtitle) ??
    stripTopicSuffix(track.subtitle ?? "")
  );
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
