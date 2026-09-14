import { findAlternateVideoId } from "@/lib/innertube/alternate-source";
import { trackArtistIds, trackArtistNames } from "@/lib/track-meta";
import { useTrackSourceStore } from "@/lib/store/track-source";
import { diagLog } from "@/lib/diagnostics";
import type { QueueTrack } from "@/lib/store/playback";

const inFlight = new Map<string, Promise<string | null>>();
const noVideo = new Set<string>();

/** Cached or freshly resolved music-video id, null when there isn't one. */
export function resolveVideoFor(track: QueueTrack): Promise<string | null> {
  const known = useTrackSourceStore.getState().byVideoId[track.videoId];
  if (known?.video) return Promise.resolve(known.video);
  if (noVideo.has(track.videoId)) return Promise.resolve(null);
  // Share an in-flight lookup; answering null would read as "no video".
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
