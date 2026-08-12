import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ListEndIcon,
  ListPlusIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RadioIcon,
  ShuffleIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  ctxPrimitives,
  dropPrimitives,
} from "@/components/shared/track-context-menu";
import { fetchAlbum } from "@/lib/innertube/album";
import { fetchRadio } from "@/lib/innertube/radio";
import { usePlaybackStore } from "@/lib/store/playback";
import type { AlbumPage, ShelfItem } from "@/lib/innertube/types";

// Album rows carry no per-track thumbnail (the cover lives at the album
// level), so backfill it before queuing — otherwise the player card and
// background cover render empty. Same treatment the album page applies.
function withCover(album: AlbumPage): ShelfItem[] {
  return album.tracks.map((t) =>
    t.thumbnails.length > 0 ? t : { ...t, thumbnails: album.thumbnails },
  );
}

/**
 * Shared state + handlers for both the right-click menu on an album card
 * and the ⋯ dropdown on the album page — same split as
 * `useTrackMenuController`, only the surrounding primitives differ.
 *
 * A card only knows the album's browse id, so every action resolves the
 * track list on demand. It goes through the *same* query key the album
 * page uses, so using this menu warms that page and vice versa. Callers
 * that already hold the page (the album route) pass it in and skip the
 * fetch entirely.
 */
export function useAlbumMenuController(albumId: string, album?: AlbumPage) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const resolve = async (): Promise<AlbumPage | null> => {
    if (album) return album;
    try {
      return await qc.fetchQuery({
        queryKey: ["album", albumId],
        queryFn: () => fetchAlbum(albumId),
        staleTime: 5 * 60_000,
      });
    } catch (e) {
      toast.error(`Couldn't load album: ${String(e)}`);
      return null;
    }
  };

  const play = async (shuffle: boolean) => {
    const a = await resolve();
    if (!a) return;
    const items = withCover(a);
    if (items.length === 0) return;
    const store = usePlaybackStore.getState();
    store.playShelfItems(
      items,
      shuffle ? Math.floor(Math.random() * items.length) : 0,
    );
    store.setShuffle(shuffle);
  };

  const playNext = async () => {
    const a = await resolve();
    if (!a) return;
    const items = withCover(a);
    if (items.length === 0) return;
    // enqueueNext always inserts directly after the current track, so
    // walking the album backwards leaves it in album order.
    for (const t of [...items].reverse()) {
      usePlaybackStore.getState().enqueueNext(t);
    }
    toast.success(`Playing next: ${a.title}`);
  };

  const addToQueue = async () => {
    const a = await resolve();
    if (!a) return;
    const items = withCover(a);
    if (items.length === 0) return;
    usePlaybackStore.getState().appendToQueue(items);
    toast.success(`Added to queue: ${a.title}`);
  };

  const startRadio = async () => {
    const a = await resolve();
    if (!a) return;
    const items = withCover(a);
    const seed = items[0];
    if (!seed) return;
    try {
      const radio = await fetchRadio(seed.id);
      usePlaybackStore
        .getState()
        .playShelfItems([seed, ...radio.filter((t) => t.id !== seed.id)], 0);
    } catch {
      void play(false);
    }
  };

  const goToArtist = async () => {
    const a = await resolve();
    if (!a) return;
    const artist = a.artists.find((x) => x.id);
    if (!artist?.id) {
      toast.error("No artist page for this album");
      return;
    }
    navigate({ to: "/artist/$id", params: { id: artist.id } });
  };

  return { play, playNext, addToQueue, startRadio, goToArtist };
}

export function AlbumMenuItems({
  controller,
  primitives,
}: {
  controller: ReturnType<typeof useAlbumMenuController>;
  primitives: typeof ctxPrimitives;
}) {
  const { Item, Separator } = primitives;
  const { play, playNext, addToQueue, startRadio, goToArtist } = controller;

  return (
    <>
      <Item onSelect={() => void play(false)}>
        <PlayIcon />
        Play
      </Item>
      <Item onSelect={() => void play(true)}>
        <ShuffleIcon />
        Shuffle play
      </Item>
      <Item onSelect={() => void playNext()}>
        <ListPlusIcon />
        Play next
      </Item>
      <Item onSelect={() => void addToQueue()}>
        <ListEndIcon />
        Add to queue
      </Item>
      <Item onSelect={() => void startRadio()}>
        <RadioIcon />
        Start radio
      </Item>

      <Separator />

      <Item onSelect={() => void goToArtist()}>
        <UserIcon />
        Go to artist
      </Item>
    </>
  );
}

/** Right-click menu for an album card. */
export function AlbumContextMenu({
  albumId,
  children,
}: {
  albumId: string;
  children: ReactNode;
}) {
  const controller = useAlbumMenuController(albumId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <AlbumMenuItems controller={controller} primitives={ctxPrimitives} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** ⋯ button for the album page header. Same actions as the card menu. */
export function AlbumMoreMenu({ album }: { album: AlbumPage }) {
  const controller = useAlbumMenuController(album.id, album);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="More actions">
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <AlbumMenuItems controller={controller} primitives={dropPrimitives} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
