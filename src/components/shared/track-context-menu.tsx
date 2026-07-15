import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListPlusIcon,
  ListEndIcon,
  RadioIcon,
  UserIcon,
  DiscAlbumIcon,
  PlayIcon,
  HeartIcon,
  HeartOffIcon,
  ThumbsDownIcon,
  ListMusicIcon,
  PlusIcon,
  MoreHorizontalIcon,
  Loader2Icon,
} from "lucide-react";
import { toast } from "sonner";
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
  createPlaylistWithTrack,
  dislikeTrack,
  fetchUserPlaylists,
  likeTrack,
  removeRating,
  type UserPlaylist,
} from "@/lib/innertube/mutations";
import { usePlaybackStore } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";
import { syncLastfmLove } from "@/lib/lastfm";

type TrackContext = { tracks: ShelfItem[]; index: number };

type Primitives = {
  Item: ComponentType<any>;
  Separator: ComponentType<any>;
  Sub: ComponentType<any>;
  SubTrigger: ComponentType<any>;
  SubContent: ComponentType<any>;
};

const ctxPrimitives: Primitives = {
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
      await likeTrack(item.id);
      qc.setQueryData<ShelfItem[]>(["liked-songs"], (old) => {
        const list = old ?? [];
        if (list.some((t) => t.id === item.id)) return list;
        return [
          { id: item.id, kind: "song", title: item.title, thumbnails: item.thumbnails } as ShelfItem,
          ...list,
        ];
      });
      toast.success("Added to Liked songs");
      syncLastfmLove(item, true);
    } catch (e) {
      toast.error(`Like failed: ${String(e)}`);
    }
  };
  const runRemoveRating = async () => {
    try {
      await removeRating(item.id);
      qc.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
        (old ?? []).filter((t) => t.id !== item.id),
      );
      toast.success("Removed from Liked songs");
      syncLastfmLove(item, false);
    } catch (e) {
      toast.error(`Remove failed: ${String(e)}`);
    }
  };
  const runDislike = async () => {
    try {
      await dislikeTrack(item.id);
      qc.setQueryData<ShelfItem[]>(["liked-songs"], (old) =>
        (old ?? []).filter((t) => t.id !== item.id),
      );
      toast.success("Marked as not interested");
      syncLastfmLove(item, false);
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
  onGoToArtist,
}: {
  item: ShelfItem;
  context?: TrackContext;
  controller: ReturnType<typeof useTrackMenuController>;
  primitives: Primitives;
  /**
   * Handler for the "Go to artist" item. Pulled out as a prop so the
   * floating-player window can short-circuit it through a Tauri event
   * (no router lives in that window) — main-window callers just
   * forward to `useNavigate()`.
   */
  onGoToArtist?: (artistId: string) => void;
}) {
  const store = usePlaybackStore.getState;
  const { Item, Separator, Sub, SubTrigger, SubContent } = primitives;
  const {
    isLiked,
    playlists,
    runLike,
    runRemoveRating,
    runDislike,
    runAddToPlaylist,
    primeUserPlaylists,
    setNewPlaylistOpen,
  } = controller;

  const artist = item.artists?.find((a) => !!a.id);
  const albumBrowseId = undefined;

  return (
    <>
      <Item
        onSelect={() => {
          if (context) store().playShelfItems(context.tracks, context.index);
          else store().playNow(item);
        }}
      >
        <PlayIcon />
        Play
      </Item>
      <Item onSelect={() => store().enqueueNext(item)}>
        <ListPlusIcon />
        Play next
      </Item>
      <Item onSelect={() => store().enqueueEnd(item)}>
        <ListEndIcon />
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
        <RadioIcon />
        Start radio
      </Item>

      <Separator />

      {isLiked ? (
        <Item onSelect={runRemoveRating}>
          <HeartOffIcon />
          Remove from liked
        </Item>
      ) : (
        <Item onSelect={runLike}>
          <HeartIcon />
          Add to liked
        </Item>
      )}
      <Item onSelect={runDislike}>
        <ThumbsDownIcon />
        Not interested
      </Item>

      <Sub>
        <SubTrigger
          onPointerEnter={primeUserPlaylists}
          onFocus={primeUserPlaylists}
        >
          <ListMusicIcon />
          Add to playlist
        </SubTrigger>
        <SubContent className="max-h-80 w-64 overflow-y-auto">
          {playlists.isFetching && !playlists.data ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
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
            <PlusIcon />
            New playlist…
          </Item>
        </SubContent>
      </Sub>

      {(artist || albumBrowseId) && <Separator />}

      {artist?.id && onGoToArtist && (
        <Item onSelect={() => onGoToArtist(artist.id!)}>
          <UserIcon />
          Go to artist
        </Item>
      )}
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
          <DiscAlbumIcon />
          Go to album
        </Item>
      )}
    </>
  );
}

type Props = {
  item: ShelfItem;
  children: ReactNode;
  /** When in a track list, we want to start from this index with context. */
  context?: TrackContext;
};

/**
 * Right-click menu for any song/video row or card. Navigation-kind
 * items (artist/album/playlist cards) use a different menu shape and
 * should not wrap their children in this component.
 */
export function TrackContextMenu({ item, children, context }: Props) {
  const controller = useTrackMenuController(item);
  const navigate = useNavigate();

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
            onGoToArtist={(id) =>
              navigate({ to: "/artist/$id", params: { id } })
            }
          />
        </ContextMenuContent>
      </ContextMenu>

      <NewPlaylistDialog
        open={controller.newPlaylistOpen}
        onOpenChange={controller.setNewPlaylistOpen}
        defaultTitle={item.title}
        videoId={item.id}
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
  className,
}: {
  item: ShelfItem;
  context?: TrackContext;
  className?: string;
}) {
  const controller = useTrackMenuController(item);
  const navigate = useNavigate();

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
            onGoToArtist={(id) =>
              navigate({ to: "/artist/$id", params: { id } })
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <NewPlaylistDialog
        open={controller.newPlaylistOpen}
        onOpenChange={controller.setNewPlaylistOpen}
        defaultTitle={item.title}
        videoId={item.id}
      />
    </>
  );
}

export function NewPlaylistDialog({
  open,
  onOpenChange,
  defaultTitle,
  videoId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultTitle: string;
  videoId: string;
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
      await createPlaylistWithTrack(t, videoId);
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
            The track will be added as the first entry. Playlists are
            created as private — you can change that later on
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
            {busy && <Loader2Icon className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
