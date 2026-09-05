import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontalIcon } from "lucide-react";
import {
  IconDiscFilled,
  IconHeartFilled,
  IconLoader2,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconPlaylist,
  IconPlus,
  IconThumbDownFilled,
} from "@tabler/icons-react";
import {
  IconHeartOffFilled,
  IconPlaylistAddFilled,
  IconPlaylistXFilled,
  IconRadioFilled,
  IconShare3Filled,
} from "@/components/shared/filled-icons";
import { toast } from "sonner";
import { copyLink } from "@/lib/clipboard";
import { universalShareUrl } from "@/lib/deep-link";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLikedIdsSet } from "@/components/shared/like-buttons";
import { fetchRadio } from "@/lib/innertube/radio";
import { fetchLikedSongs } from "@/lib/innertube/library";
import {
  addToPlaylist,
  createPlaylistWithTracks,
  fetchUserPlaylists,
  removeFromPlaylist,
  type UserPlaylist,
} from "@/lib/innertube/mutations";
import { toggleDisliked, toggleLiked } from "@/lib/like-actions";
import { useSettingsStore } from "@/lib/store/settings";
import { usePlaybackStore } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";

type TrackContext = { tracks: ShelfItem[]; index: number };

/**
 * Set by pages that render an *editable* playlist the user owns. Turns
 * on the "Remove from playlist" item, which needs the raw ("PL…")
 * playlist id for the edit_playlist call.
 */
export type PlaylistRemovalContext = { playlistId: string };

type Primitives = {
  Item: ComponentType<any>;
  Separator: ComponentType<any>;
  Sub: ComponentType<any>;
  SubTrigger: ComponentType<any>;
  SubContent: ComponentType<any>;
};

export const ctxPrimitives: Primitives = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

export const dropPrimitives: Primitives = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

/**
 * Shared state + handlers used by both the right-click context menu
 * and the ⋯ "more" dropdown. Both menus expose the same actions, so
 * they share the same controller — only the surrounding primitives
 * differ.
 */
export function useTrackMenuController(item: ShelfItem) {
  const qc = useQueryClient();
  const [newPlaylistOpen, setNewPlaylistOpen] = useState(false);

  const liked = useQuery({
    queryKey: ["liked-songs"],
    queryFn: () => fetchLikedSongs(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const playlists = useQuery({
    queryKey: ["user-playlists"],
    queryFn: () => fetchUserPlaylists(),
    staleTime: 60_000,
    retry: false,
    enabled: false,
  });

  // O(1) lookup via shared id-set memo (see like-buttons.tsx for the
  // module-level memo). Avoids the per-render N×M scan we'd otherwise
  // get on long playlists.
  const isLiked = useMemo(
    () => getLikedIdsSet(liked.data).has(item.id),
    [liked.data, item.id],
  );

  const runLike = async () => {
    try {
      await toggleLiked({
        queryClient: qc,
        videoId: item.id,
        wasLiked: false,
        track: item,
      });
    } catch (e) {
      toast.error(`Like failed: ${String(e)}`);
    }
  };
  const runRemoveRating = async () => {
    try {
      await toggleLiked({
        queryClient: qc,
        videoId: item.id,
        wasLiked: true,
        track: item,
      });
    } catch (e) {
      toast.error(`Remove failed: ${String(e)}`);
    }
  };
  const runDislike = async () => {
    try {
      await toggleDisliked({
        queryClient: qc,
        videoId: item.id,
        wasDisliked: false,
        wasLiked: isLiked,
        track: item,
      });
    } catch (e) {
      toast.error(`Failed: ${String(e)}`);
    }
  };
  const runAddToPlaylist = async (p: UserPlaylist) => {
    try {
      await addToPlaylist(p.id, item.id);
      // The playlist page keys its data as ["playlist-pages", id] (with a
      // possibly VL-prefixed id), so ["playlist", p.id] never matched and
      // the invalidation was a no-op. Prefix-match every open playlist page.
      await qc.invalidateQueries({ queryKey: ["playlist-pages"] });
      toast.success(`Added to ${p.title}`);
    } catch (e) {
      toast.error(`Add failed: ${String(e)}`);
    }
  };

  const runRemoveFromPlaylist = async (removal: PlaylistRemovalContext) => {
    const setVideoId = item.setVideoId;
    if (!setVideoId) return;
    try {
      await removeFromPlaylist(removal.playlistId, item.id, setVideoId);
      // Drop the row from every cached playlist page in place instead of
      // invalidating: an invalidation refetches ALL loaded pages of the
      // infinite query, which on a large playlist is 100+ requests.
      // setVideoId is unique per playlist entry, so matching on it can't
      // touch other playlists' caches (or a duplicate of the same song).
      qc.setQueriesData<{
        pages: { tracks: ShelfItem[] }[];
        pageParams: unknown[];
      }>({ queryKey: ["playlist-pages"] }, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            tracks: p.tracks.filter((t) => t.setVideoId !== setVideoId),
          })),
        };
      });
      toast.success("Removed from playlist");
    } catch (e) {
      toast.error(`Remove failed: ${String(e)}`);
    }
  };

  const primeUserPlaylists = () => {
    if (!playlists.data && !playlists.isFetching && !playlists.isError) {
      void qc.fetchQuery({
        queryKey: ["user-playlists"],
        queryFn: () => fetchUserPlaylists(),
        staleTime: 60_000,
      });
    }
  };

  return {
    isLiked,
    playlists,
    runLike,
    runRemoveRating,
    runDislike,
    runAddToPlaylist,
    runRemoveFromPlaylist,
    primeUserPlaylists,
    newPlaylistOpen,
    setNewPlaylistOpen,
  };
}

export function TrackMenuItems({
  item,
  context,
  controller,
  primitives,
  removal,
}: {
  item: ShelfItem;
  context?: TrackContext;
  controller: ReturnType<typeof useTrackMenuController>;
  primitives: Primitives;
  /** Present only on an editable (user-owned) playlist page. */
  removal?: PlaylistRemovalContext;
}) {
  const store = usePlaybackStore.getState;
  const { Item, Separator, Sub, SubTrigger, SubContent } = primitives;
  // With thumbs on every row the rating items would only repeat them.
  const thumbs = useSettingsStore((s) => s.ratingButtons === "both");
  const {
    isLiked,
    playlists,
    runLike,
    runRemoveRating,
    runDislike,
    runAddToPlaylist,
    runRemoveFromPlaylist,
    primeUserPlaylists,
    setNewPlaylistOpen,
  } = controller;

  const albumBrowseId = undefined;

  return (
    <>
      <Item
        onSelect={() => {
          if (context) store().playShelfItems(context.tracks, context.index);
          else store().playNow(item);
        }}
      >
        <IconPlayerPlayFilled />
        Play
      </Item>
      <Item onSelect={() => store().enqueueNext(item)}>
        <IconPlayerTrackNextFilled />
        Play next
      </Item>
      <Item onSelect={() => store().enqueueEnd(item)}>
        <IconPlaylistAddFilled />
        Add to queue
      </Item>
      <Item
        onSelect={async () => {
          try {
            const radio = await fetchRadio(item.id);
            const rest = radio.filter((t) => t.id !== item.id);
            store().playShelfItems([item, ...rest], 0);
          } catch {
            store().playNow(item);
          }
        }}
      >
        <IconRadioFilled />
        Start radio
      </Item>

      <Separator />

      {thumbs ? null : (
        <>
          {isLiked ? (
            <Item variant="destructive" onSelect={runRemoveRating}>
              <IconHeartOffFilled />
              Remove from liked
            </Item>
          ) : (
            <Item onSelect={runLike}>
              <IconHeartFilled />
              Add to liked
            </Item>
          )}
          <Item onSelect={runDislike}>
            <IconThumbDownFilled />
            Not interested
          </Item>
        </>
      )}

      <Sub>
        <SubTrigger
          onPointerEnter={primeUserPlaylists}
          onFocus={primeUserPlaylists}
        >
          <IconPlaylist />
          Add to playlist
        </SubTrigger>
        <SubContent className="max-h-80 w-64 overflow-y-auto">
          {playlists.isFetching && !playlists.data ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <IconLoader2 className="size-3 animate-spin" />
              Loading…
            </div>
          ) : playlists.isError ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              Sign in to add to playlists.
            </div>
          ) : (playlists.data ?? []).length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No playlists yet.
            </div>
          ) : (
            (playlists.data ?? []).map((p) => (
              <Item key={p.id} onSelect={() => runAddToPlaylist(p)}>
                <span className="truncate">{p.title}</span>
              </Item>
            ))
          )}
          <Separator />
          <Item onSelect={() => setNewPlaylistOpen(true)}>
            <IconPlus />
            New playlist…
          </Item>
        </SubContent>
      </Sub>

      {removal && item.setVideoId ? (
        <Item
          variant="destructive"
          onSelect={() => runRemoveFromPlaylist(removal)}
        >
          <IconPlaylistXFilled />
          Remove from playlist
        </Item>
      ) : null}

      {albumBrowseId && <Separator />}

      {albumBrowseId && (
        <Item
          onSelect={() => {
            // Album navigation isn't wired yet — `albumBrowseId` is
            // currently always undefined so this branch never runs.
            // Left as a placeholder for when album browse IDs start
            // flowing through.
            void albumBrowseId;
          }}
        >
          <IconDiscFilled />
          Go to album
        </Item>
      )}

      <Separator />

      {/* One link for everyone: the share page opens the track in YTubic
          when it's installed and falls back to YouTube Music when it isn't. */}
      <Item onSelect={() => void copyLink(universalShareUrl("watch", item.id))}>
        <IconShare3Filled />
        Share
      </Item>
    </>
  );
}

type Props = {
  item: ShelfItem;
  children: ReactNode;
  /** When in a track list, we want to start from this index with context. */
  context?: TrackContext;
  /** Present only on an editable (user-owned) playlist page. */
  removal?: PlaylistRemovalContext;
};

/**
 * Right-click menu for any song/video row or card. Navigation-kind
 * items (artist/album/playlist cards) use a different menu shape and
 * should not wrap their children in this component.
 */
export function TrackContextMenu({ item, children, context, removal }: Props) {
  const controller = useTrackMenuController(item);

  if (item.kind !== "song" && item.kind !== "video") {
    return <>{children}</>;
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <TrackMenuItems
            item={item}
            context={context}
            controller={controller}
            primitives={ctxPrimitives}
            removal={removal}
          />
        </ContextMenuContent>
      </ContextMenu>

      <NewPlaylistDialog
        open={controller.newPlaylistOpen}
        onOpenChange={controller.setNewPlaylistOpen}
        defaultTitle={item.title}
        videoIds={[item.id]}
      />
    </>
  );
}

/**
 * Triple-dot button rendered in the Actions column of a track row.
 * Opens the same menu as right-clicking the row.
 */
export function TrackMoreMenu({
  item,
  context,
  removal,
  className,
}: {
  item: ShelfItem;
  context?: TrackContext;
  /** Present only on an editable (user-owned) playlist page. */
  removal?: PlaylistRemovalContext;
  className?: string;
}) {
  const controller = useTrackMenuController(item);

  if (item.kind !== "song" && item.kind !== "video") return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={className ?? "size-7"}
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          onClick={(e) => e.stopPropagation()}
        >
          <TrackMenuItems
            item={item}
            context={context}
            controller={controller}
            primitives={dropPrimitives}
            removal={removal}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <NewPlaylistDialog
        open={controller.newPlaylistOpen}
        onOpenChange={controller.setNewPlaylistOpen}
        defaultTitle={item.title}
        videoIds={[item.id]}
      />
    </>
  );
}

export function NewPlaylistDialog({
  open,
  onOpenChange,
  defaultTitle,
  videoIds,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultTitle: string;
  videoIds: string[];
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTitle(defaultTitle);
  }, [open, defaultTitle]);

  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await createPlaylistWithTracks(t, videoIds);
      await qc.invalidateQueries({ queryKey: ["user-playlists"] });
      await qc.invalidateQueries({ queryKey: ["library"] });
      toast.success(`Created "${t}"`);
      onOpenChange(false);
    } catch (e) {
      toast.error(`Create failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New playlist</DialogTitle>
          <DialogDescription>
            {videoIds.length === 1
              ? "The track will be added as the first entry."
              : `The ${videoIds.length} tracks will be added in order.`}{" "}
            Playlists are created as private — you can change that later on
            music.youtube.com.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Playlist name"
          disabled={busy}
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !title.trim()}>
            {busy && <IconLoader2 className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
