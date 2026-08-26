import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAlbumIdForVideo } from "@/lib/innertube/album";
import { usePlaybackStore } from "@/lib/store/playback";

/**
 * Album browse id for a song/video. Uses the id already on the item when
 * present; otherwise looks it up from `/next` and stamps the queue so
 * the player ⋮ menu can show "Go to album".
 */
export function useTrackAlbumId(
  videoId: string | undefined,
  knownId?: string,
): string | undefined {
  const query = useQuery({
    queryKey: ["track-album-id", videoId],
    queryFn: async () => (await fetchAlbumIdForVideo(videoId!)) ?? null,
    enabled: !!videoId && !knownId,
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!videoId || !query.data) return;
    usePlaybackStore.getState().patchQueueTrack(videoId, {
      albumId: query.data,
    });
  }, [videoId, query.data]);

  return knownId ?? query.data ?? undefined;
}

/** Resolve the now-playing track's album id before the ⋮ menu opens. */
export function useResolveCurrentAlbum(): void {
  const videoId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
  );
  const albumId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.albumId : undefined,
  );
  useTrackAlbumId(videoId, albumId);
}
