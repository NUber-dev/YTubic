import { useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fetchLikedSongs } from "@/lib/innertube/library";
import { likeTrack, removeRating } from "@/lib/innertube/mutations";
import type { ShelfItem } from "@/lib/innertube/types";
import { syncLastfmLove, type LastfmTrackMeta } from "@/lib/lastfm";
import { cn } from "@/lib/utils";

// Patch the cached liked-songs list optimistically. The server is the
// source of truth, but `["liked-songs"]` is `enabled: false` in this
// component (and in the context menu) so an `invalidateQueries` call
// would NOT refetch — meaning the heart wouldn't fill until the user
// visited Settings or the Liked Songs page. Mutating the cache
// directly keeps every observer (player bar, track rows, context
// menus, settings cache list) in sync without a network round-trip.
function makeLikedPlaceholder(videoId: string): ShelfItem {
  return { id: videoId, kind: "song", title: "", thumbnails: [] };
}

// Module-level memo of the liked-id Set. With ~5k liked tracks and ~100
// LikeDislikeButtons on a single page, doing `(liked.data ?? []).some(...)`
// per render becomes ~500k comparisons. The Set + identity-keyed memo
// collapses that to one rebuild per actual data change, shared across all
// observers.
let likedSetMemo: { data: ShelfItem[] | undefined; set: Set<string> } = {
  data: undefined,
  set: new Set(),
};
export function getLikedIdsSet(data: ShelfItem[] | undefined): Set<string> {
  if (likedSetMemo.data === data) return likedSetMemo.set;
  const set = new Set((data ?? []).map((t) => t.id));
  likedSetMemo = { data, set };
  return set;
}

type Props = {
  videoId: string;
  /** Track metadata for the Last.fm loved-track sync. Optional: without it a
   *  like still works, it just isn't mirrored to Last.fm. */
  track?: LastfmTrackMeta;
  className?: string;
  /** Compact mode uses size-8 ghost buttons (for track rows). Default
   *  is size-9 (for the player bar). */
  compact?: boolean;
  /** When true, only shows if the track is liked OR on hover of the
   *  row. Caller controls hover visibility via CSS; we just render
   *  the buttons and let `group-hover:*` classes do the work. */
  hideUnlessLiked?: boolean;
};

export function LikeDislikeButtons({
  videoId,
  track,
  className,
  compact,
  hideUnlessLiked,
}: Props) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"like" | null>(null);

  // Fetched lazily on first observer (e.g. when the player bar mounts
  // with a track or a track list renders). Tanstack-query dedupes
  // across the dozens of LikeDislikeButtons instances on a page, so
  // this still triggers a single network round of continuations. The
  // result is persisted via `shouldPersistQuery` in query-client.ts,
  // so reloads stay accurate without re-fetching.
  const liked = useQuery({
    queryKey: ["liked-songs"],
    queryFn: () => fetchLikedSongs(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const isLiked = getLikedIdsSet(liked.data).has(videoId);

  const btnSize = compact ? "size-7" : "size-9";
  const iconSize = compact ? "size-3.5" : "size-4";

  const onLike = async (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy("like");
    const wasLiked = isLiked;
    try {
      if (wasLiked) {
        await removeRating(videoId);
        qc.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
          (old ?? []).filter((t) => t.id !== videoId),
        );
        toast.success("Removed from Liked");
      } else {
        await likeTrack(videoId);
        qc.setQueryData<ShelfItem[]>(["liked-songs"], (old) => {
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
      void qc.invalidateQueries({ queryKey: ["library", "liked-songs-pages"] });
      void qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "playlist-pages" &&
          typeof q.queryKey[1] === "string" &&
          (q.queryKey[1] as string).includes("LM"),
      });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  const hoverVisibility = hideUnlessLiked && !isLiked
    ? "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
    : "";

  return (
    <div className={cn("flex items-center", hoverVisibility, className)}>
      <Button
        variant="ghost"
        size="icon"
        className={btnSize}
        onClick={onLike}
        disabled={busy !== null}
        aria-label={isLiked ? "Remove from liked" : "Add to liked"}
        aria-pressed={isLiked}
      >
        <HeartIcon
          className={cn(iconSize, isLiked && "fill-current text-brand")}
        />
      </Button>
    </div>
  );
}
