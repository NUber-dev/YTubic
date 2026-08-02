import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { likeTrack, removeRating } from "@/lib/innertube/mutations";
import type { ShelfItem } from "@/lib/innertube/types";
import { syncLastfmLove, type LastfmTrackMeta } from "@/lib/lastfm";

// Patch the cached liked-songs list optimistically. The server is the
// source of truth, but `["liked-songs"]` is `enabled: false` in the
// components that only *read* it, so an `invalidateQueries` call would
// NOT refetch — meaning the heart wouldn't fill until the user visited
// Settings or the Liked Songs page. Mutating the cache directly keeps
// every observer (player bar, track rows, context menus, settings cache
// list, the taskbar thumbnail toolbar) in sync without a round-trip.
function makeLikedPlaceholder(videoId: string): ShelfItem {
  return { id: videoId, kind: "song", title: "", thumbnails: [] };
}

/**
 * Like or unlike a track and keep every cached view of the liked list in
 * sync. Shared by the heart button, and by the OS-level controls (the
 * Windows taskbar thumbnail toolbar) which have no React tree to hang a
 * component off. Throws on a failed mutation; the toast is emitted here.
 */
export async function toggleLiked({
  queryClient,
  videoId,
  wasLiked,
  track,
}: {
  queryClient: QueryClient;
  videoId: string;
  wasLiked: boolean;
  /** Metadata for the Last.fm loved-track sync. Without it a like still
   *  works, it just isn't mirrored to Last.fm. */
  track?: LastfmTrackMeta;
}): Promise<void> {
  if (wasLiked) {
    await removeRating(videoId);
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
      (old ?? []).filter((t) => t.id !== videoId),
    );
    toast.success("Removed from Liked");
  } else {
    await likeTrack(videoId);
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) => {
      const list = old ?? [];
      if (list.some((t) => t.id === videoId)) return list;
      return [makeLikedPlaceholder(videoId), ...list];
    });
    toast.success("Added to Liked");
  }
  // Mirror the like/unlike to Last.fm as a loved / unloved track.
  syncLastfmLove(track, !wasLiked);
  // The heart-fill cache (["liked-songs"]) is separate from the
  // Library → Songs list (["library","liked-songs-pages"]) and the
  // Liked Songs (LM) playlist page (["playlist-pages", …"LM"…]). Mark
  // those stale so they don't keep showing an outdated list. They're
  // heavy infinite queries, so invalidate only refetches if mounted.
  void queryClient.invalidateQueries({
    queryKey: ["library", "liked-songs-pages"],
  });
  void queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "playlist-pages" &&
      typeof q.queryKey[1] === "string" &&
      (q.queryKey[1] as string).includes("LM"),
  });
}
