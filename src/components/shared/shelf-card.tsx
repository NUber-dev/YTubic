import { useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2Icon,
  PlayIcon,
  PinIcon,
  PinOffIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronRightIcon,
  ZapIcon,
  DumbbellIcon,
  CarIcon,
  HeartIcon,
  CloudRainIcon,
  SmileIcon,
  MoonIcon,
  TargetIcon,
  PartyPopperIcon,
  CoffeeIcon,
  UsersIcon,
  MusicIcon,
  Music2Icon,
  Music3Icon,
  Music4Icon,
  MicIcon,
  GuitarIcon,
  PianoIcon,
  SkullIcon,
  FilmIcon,
  BabyIcon,
  ChurchIcon,
  SnowflakeIcon,
  GlobeIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { Thumbnail } from "@/components/shared/thumbnail";
import { LikedCover } from "@/components/shared/liked-cover";
import { TrackContextMenu } from "@/components/shared/track-context-menu";
import {
  AlbumContextMenu,
  useAlbumMenuController,
} from "@/components/shared/album-menu";
import { playPlaylistNow } from "@/lib/play-playlist";
import { usePlaybackStore } from "@/lib/store/playback";
import {
  useIsHidden,
  useIsPinned,
  usePinnedPlaylistsStore,
} from "@/lib/store/pinned-playlists";
import { ExplicitBadge } from "@/components/shared/explicit-badge";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  item: ShelfItem;
  className?: string;
};

// Per-category icons for Moods & Genres tiles. The InnerTube payload only
// gives us a title + tint color, so the icon is a heuristic by lowercase
// title. Fallback `Music2` for unmatched titles, `Globe` when the title
// looks like a region/language tag.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  energize: ZapIcon,
  workout: DumbbellIcon,
  commute: CarIcon,
  romance: HeartIcon,
  sad: CloudRainIcon,
  "feel good": SmileIcon,
  sleep: MoonIcon,
  focus: TargetIcon,
  party: PartyPopperIcon,
  chill: CoffeeIcon,
  family: UsersIcon,
  pop: MusicIcon,
  "hip-hop": MicIcon,
  country: GuitarIcon,
  "r&b": MicIcon,
  rock: GuitarIcon,
  soul: Music3Icon,
  latin: GuitarIcon,
  "indie & alternative": Music3Icon,
  classical: PianoIcon,
  "dance & electronic": Music4Icon,
  blues: Music3Icon,
  jazz: Music3Icon,
  metal: SkullIcon,
  reggae: Music4Icon,
  "folk & acoustic": GuitarIcon,
  "soundtracks & musicals": FilmIcon,
  "children's music": BabyIcon,
  "christian & gospel": ChurchIcon,
  holiday: SnowflakeIcon,
};

const GEO_KEYWORDS = [
  "iraqi",
  "russian",
  "turkish",
  "arabic",
  "indian",
  "spanish",
  "french",
  "german",
  "japanese",
  "korean",
  "k-pop",
  "chinese",
  "pakistani",
  "afghan",
  "egyptian",
  "lebanese",
  "tamil",
  "punjabi",
  "hindi",
  "thai",
  "vietnamese",
  "world",
];

function pickCategoryIcon(title: string): LucideIcon {
  const key = title.toLowerCase();
  if (CATEGORY_ICONS[key]) return CATEGORY_ICONS[key];
  if (GEO_KEYWORDS.some((g) => key.includes(g))) return GlobeIcon;
  return Music2Icon;
}

const CARD_CLASS =
  "group flex w-full flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none";

export function ShelfCard({ item, className }: Props) {
  const subtitle =
    item.subtitle ??
    item.artists?.map((a) => a.name).join(", ") ??
    item.album ??
    "";

  const isVideo = item.kind === "video";
  // Albums and playlists get a slightly softer corner than the
  // default rounded-md (6px) — 8px / rounded-lg reads as "physical
  // record sleeve" vs the tighter rounding on songs/videos.
  const isAlbumOrPlaylist =
    item.kind === "album" || item.kind === "playlist";
  const radiusClass = item.round
    ? "rounded-full"
    : isAlbumOrPlaylist
      ? "rounded-lg"
      : "rounded-md";

  // Only playlists are hideable, so this is always false for other kinds
  // — the badge below scopes itself to hidden playlists. Reading it here
  // (rather than in a playlist-only sub-component) keeps radiusClass and
  // the thumbnail layout in one place; the selector is cheap and only
  // ever changes on an explicit hide/show.
  const hidden = useIsHidden(item.id);

  // Liked songs wears the cover the user picked on its page, not the
  // heart YouTube ships for it.
  const isLiked =
    item.kind === "playlist" && (item.id === "VLLM" || item.id === "LM");

  // Albums and real playlists get a play button on hover: the card
  // itself still opens the page, the button starts playback in place.
  const hoverPlay =
    item.kind === "album" ? (
      <AlbumPlayButton albumId={item.id} />
    ) : item.kind === "playlist" && !item.playableVideoId ? (
      <PlaylistPlayButton playlistId={item.id} />
    ) : null;

  const body = (
    <>
      <div
        className={cn(
          "relative w-full",
          isVideo ? "aspect-video" : "aspect-square",
        )}
      >
        {isLiked ? (
          <LikedCover className={cn("size-full", radiusClass)} />
        ) : (
          <Thumbnail
            thumbnails={item.thumbnails}
            alt={item.title}
            round={item.round}
            className={cn("size-full", radiusClass)}
            targetSize={isVideo ? 480 : 256}
            highRes
          />
        )}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 border border-hairline",
            radiusClass,
          )}
        />
        {isVideo && item.duration ? (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
            {formatDuration(item.duration)}
          </span>
        ) : null}
        {hoverPlay}
        {hidden ? (
          <>
            {/* Mute the cover and stamp a crossed-out eye so a
                sidebar-hidden playlist reads as hidden at a glance. */}
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 bg-background/60",
                radiusClass,
              )}
            />
            <div
              title="Hidden from sidebar"
              className="absolute right-1.5 top-1.5 flex items-center justify-center rounded-md bg-black/65 p-1 text-white shadow-sm backdrop-blur-sm"
            >
              <EyeOffIcon className="size-4" />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            item.round && "justify-center",
          )}
        >
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.explicit ? <ExplicitBadge /> : null}
        </div>
        {subtitle ? (
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              item.round && "text-center",
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
    </>
  );

  if (item.kind === "category") {
    // Horizontal pill with a colored left border (rounded with the card)
    // and a soft inner glow leaking from the left edge. browseId + params
    // get stitched back together on /moods/$id via the `p` search param.
    const tint = item.tint ?? "#666";
    const Icon = pickCategoryIcon(item.title);
    return (
      <Link
        to="/moods/$id"
        params={{ id: item.id }}
        search={{ p: item.categoryParams ?? "", t: item.title }}
        className={cn(
          "group relative flex h-14 w-full items-center gap-3 overflow-hidden rounded-lg border-l-4 bg-w050 px-3 transition-transform hover:scale-[1.01] active:scale-[0.99]",
          className,
        )}
        style={{ borderLeftColor: tint }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 70% 130% at 0% 50%, ${tint}26, transparent 70%)`,
          }}
        />
        <Icon
          className="relative z-10 size-5 shrink-0"
          style={{ color: tint }}
        />
        <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium text-t1">
          {item.title}
        </span>
        <ChevronRightIcon className="relative z-10 size-4 shrink-0 text-t7" />
        <ArtworkOutline className="rounded-lg" />
      </Link>
    );
  }

  if (item.kind === "artist") {
    return (
      <Link
        to="/artist/$id"
        params={{ id: item.id }}
        className={cn(CARD_CLASS, className)}
      >
        {body}
      </Link>
    );
  }

  if (item.kind === "album") {
    return (
      <AlbumContextMenu albumId={item.id}>
        <Link
          to="/album/$id"
          params={{ id: item.id }}
          className={cn(CARD_CLASS, className)}
        >
          {body}
        </Link>
      </AlbumContextMenu>
    );
  }

  if (item.kind === "playlist") {
    // Long-form video masquerading as a playlist (description-timestamp
    // chapters). Our /playlist/$id can't render it; play the video instead.
    if (item.playableVideoId) {
      const asSong: ShelfItem = {
        ...item,
        kind: "song",
        id: item.playableVideoId,
      };
      return (
        <TrackContextMenu item={asSong}>
          <button
            type="button"
            className={cn(CARD_CLASS, className)}
            onClick={() => usePlaybackStore.getState().playNow(asSong)}
          >
            {body}
          </button>
        </TrackContextMenu>
      );
    }
    return (
      <PlaylistPinContextMenu item={item}>
        <Link
          to="/playlist/$id"
          params={{ id: item.id }}
          className={cn(CARD_CLASS, className)}
        >
          {body}
        </Link>
      </PlaylistPinContextMenu>
    );
  }

  // song / video — clicking plays the track. Right-click → context menu.
  return (
    <TrackContextMenu item={item}>
      <button
        type="button"
        className={cn(CARD_CLASS, className)}
        onClick={() => usePlaybackStore.getState().playNow(item)}
      >
        {body}
      </button>
    </TrackContextMenu>
  );
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The accent play disc in a card's corner. Hidden until the card is
 * hovered or the button itself is focused; stays up while its fetch
 * runs so the spinner has somewhere to be. Sits inside the card's
 * link, so it swallows the click before the link can navigate.
 */
function HoverPlayButton({
  label,
  onPlay,
}: {
  label: string;
  onPlay: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onPlay();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => void handle(e)}
      className={cn(
        "absolute bottom-2 right-2 grid size-9 cursor-pointer place-items-center rounded-full bg-acc1 text-white shadow-[0_6px_16px_-4px_rgba(0,0,0,0.6)] outline-none transition-[opacity,transform,filter] duration-150 hover:brightness-110 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-[rgba(var(--acc1rgb),0.35)]",
        busy
          ? "opacity-100"
          : "translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100",
      )}
    >
      {busy ? (
        <Loader2Icon className="size-4 animate-spin" />
      ) : (
        <PlayIcon className="ml-0.5 size-4 fill-current" />
      )}
    </button>
  );
}

function AlbumPlayButton({ albumId }: { albumId: string }) {
  const { play } = useAlbumMenuController(albumId);
  return <HoverPlayButton label="Play album" onPlay={() => play(false)} />;
}

function PlaylistPlayButton({ playlistId }: { playlistId: string }) {
  const qc = useQueryClient();
  return (
    <HoverPlayButton
      label="Play playlist"
      onPlay={async () => {
        try {
          const started = await playPlaylistNow(playlistId, qc);
          if (!started) toast.error("This playlist is empty");
        } catch (e) {
          toast.error(`Couldn't load playlist: ${String(e)}`);
        }
      }}
    />
  );
}

function PlaylistPinContextMenu({
  item,
  children,
}: {
  item: ShelfItem;
  children: ReactNode;
}) {
  const pinned = useIsPinned(item.id);
  const hidden = useIsHidden(item.id);
  const pin = usePinnedPlaylistsStore((s) => s.pin);
  const unpin = usePinnedPlaylistsStore((s) => s.unpin);
  const hide = usePinnedPlaylistsStore((s) => s.hide);
  const unhide = usePinnedPlaylistsStore((s) => s.unhide);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {pinned ? (
          <ContextMenuItem onSelect={() => unpin(item.id)}>
            <PinOffIcon />
            Unpin from sidebar
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            onSelect={() =>
              pin({
                id: item.id,
                title: item.title,
                thumbnailUrl:
                  item.thumbnails[item.thumbnails.length - 1]?.url,
              })
            }
          >
            <PinIcon />
            Pin to sidebar
          </ContextMenuItem>
        )}
        {hidden ? (
          <ContextMenuItem onSelect={() => unhide(item.id)}>
            <EyeIcon />
            Show in sidebar
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => hide(item.id)}>
            <EyeOffIcon />
            Hide from sidebar
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
