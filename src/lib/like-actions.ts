import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  dislikeTrack,
  likeTrack,
  removeRating,
} from "@/lib/innertube/mutations";
import type { ShelfItem } from "@/lib/innertube/types";
import { syncLastfmLove, type LastfmTrackMeta } from "@/lib/lastfm";
import { useDislikesStore } from "@/lib/store/dislikes";

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
  } else {
    await likeTrack(videoId);
    // A like replaces a dislike on the server; mirror that locally.
    useDislikesStore.getState().remove(videoId);
  }

  // A cold-start membership fetch may have captured the list before this
  // mutation. Cancel it at the cache commit point so its older snapshot cannot
  // overwrite the patch below. If we interrupted one, restart it after the
  // patch to recover the complete membership list rather than leaving a
  // partial placeholder-only cache.
  const likedSongsKey = ["liked-songs"] as const;
  const interruptedFetch =
    queryClient.isFetching({ queryKey: likedSongsKey, exact: true }) > 0;
  await queryClient.cancelQueries({ queryKey: likedSongsKey, exact: true });

  if (wasLiked) {
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
      (old ?? []).filter((t) => t.id !== videoId),
    );
    toast.success("Removed from Liked");
  } else {
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) => {
      const list = old ?? [];
      if (list.some((t) => t.id === videoId)) return list;
      return [makeLikedPlaceholder(videoId), ...list];
    });
    toast.success("Added to Liked");
  }
  if (interruptedFetch) {
    void queryClient.invalidateQueries({
      queryKey: likedSongsKey,
      exact: true,
      refetchType: "all",
    });
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

/**
 * Dislike a track, or clear the dislike again. The server treats a
 * dislike as replacing any like, so the liked-list cache is patched the
 * same way an unlike is; the dislike itself is remembered in
 * `store/dislikes.ts` (see there for why it's local).
 */
export async function toggleDisliked({
  queryClient,
  videoId,
  wasDisliked,
  wasLiked,
  track,
}: {
  queryClient: QueryClient;
  videoId: string;
  wasDisliked: boolean;
  wasLiked: boolean;
  track?: LastfmTrackMeta;
}): Promise<void> {
  const dislikes = useDislikesStore.getState();
  if (wasDisliked) {
    await removeRating(videoId);
    dislikes.remove(videoId);
    toast.success("Dislike removed");
    return;
  }
  await dislikeTrack(videoId);
  dislikes.add(videoId);
  if (wasLiked) {
    await queryClient.cancelQueries({ queryKey: ["liked-songs"], exact: true });
    queryClient.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
      (old ?? []).filter((t) => t.id !== videoId),
    );
    syncLastfmLove(track, false);
    void queryClient.invalidateQueries({
      queryKey: ["library", "liked-songs-pages"],
    });
  }
  toast.success("Disliked");
}
