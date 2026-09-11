import { findAlternateVideoId } from "@/lib/innertube/alternate-source";
import { trackArtistIds, trackArtistNames } from "@/lib/track-meta";
import { useTrackSourceStore } from "@/lib/store/track-source";
import { diagLog } from "@/lib/diagnostics";
import type { QueueTrack } from "@/lib/store/playback";

const inFlight = new Map<string, Promise<string | null>>();
const noVideo = new Set<string>();

/**
 * The music-video id for a track, from cache or resolved on demand.
 * Deduped by videoId: the follow effect and the next-track prefetcher
 * both ask about the same track, and each miss costs a search plus a
 * round of yt-dlp verification.
 *
 * Returns null when the track has no video worth switching to, which is
 * a real answer and gets cached as such by the caller staying on song.
 */
export function resolveVideoFor(track: QueueTrack): Promise<string | null> {
  const known = useTrackSourceStore.getState().byVideoId[track.videoId];
  if (known?.video) return Promise.resolve(known.video);
  if (noVideo.has(track.videoId)) return Promise.resolve(null);
  // Share the running lookup rather than reporting "none": skipping makes
  // the prefetcher and the follow effect ask about the same track at once,
  // and answering the second one null drops it back to audio for a track
  // whose video was seconds from arriving.
  const running = inFlight.get(track.videoId);
  if (running) return running;

  const job = (async () => {
    try {
      const artistNames = trackArtistNames(track);
      const query = `${track.title} ${artistNames.join(" ")}`.trim();
      const altId = await findAlternateVideoId(
        query,
        track.videoId,
        "video",
        artistNames,
        track.title,
        trackArtistIds(track),
        track.duration,
      );
      if (altId) {
        useTrackSourceStore
          .getState()
          .setAlternate(track.videoId, "video", altId);
      } else {
        noVideo.add(track.videoId);
        diagLog(
          "alt-video",
          `no video worth switching to for "${track.title}" (${track.videoId}), staying on the song`,
        );
      }
      return altId;
    } catch {
      return null;
    } finally {
      inFlight.delete(track.videoId);
    }
  })();
  inFlight.set(track.videoId, job);
  return job;
}
