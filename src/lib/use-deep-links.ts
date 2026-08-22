import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { listenDeepLinks } from "@/lib/deep-link";
import { fetchRadio } from "@/lib/innertube/radio";
import { usePlaybackStore } from "@/lib/store/playback";

/** Route `ytubic://` links into the app: play a track or open a page. */
export function useDeepLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    return listenDeepLinks((t) => {
      switch (t.kind) {
        case "artist":
          void navigate({ to: "/artist/$id", params: { id: t.id } });
          break;
        case "album":
          void navigate({ to: "/album/$id", params: { id: t.id } });
          break;
        case "playlist":
          void navigate({ to: "/playlist/$id", params: { id: t.id } });
          break;
        case "watch":
          void playVideoId(t.id);
          break;
      }
    });
  }, [navigate]);
}

async function playVideoId(videoId: string) {
  const { playNow } = usePlaybackStore.getState();
  try {
    // The radio queue is seeded with the track itself, which also gives
    // us its title / cover without a separate metadata call.
    const tracks = await fetchRadio(videoId);
    const seed = tracks.find((x) => x.id === videoId);
    if (seed) {
      const rest = tracks
        .filter((x) => x !== seed && (x.kind === "song" || x.kind === "video"))
        .map((x) => ({
          videoId: x.id,
          title: x.title,
          subtitle: x.subtitle,
          artists: x.artists,
          album: x.album,
          thumbnails: x.thumbnails,
          duration: x.duration,
        }));
      playNow(seed, rest);
      return;
    }
  } catch (e) {
    console.warn("[deep-link] radio lookup failed", e);
  }
  // Bare fallback: the player resolves the stream from the id alone.
  playNow({ kind: "song", id: videoId, title: videoId, thumbnails: [] });
  toast.message("Playing shared track");
}
