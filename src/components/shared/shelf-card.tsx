import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  PinIcon,
  PinOffIcon,
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
import { Thumbnail } from "@/components/shared/thumbnail";
import { TrackContextMenu } from "@/components/shared/track-context-menu";
import { usePlaybackStore } from "@/lib/store/playback";
import {
  useIsPinned,
  usePinnedPlaylistsStore,
} from "@/lib/store/pinned-playlists";
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

  const body = (
    <>
      <div
        className={cn(
          "relative w-full",
          isVideo ? "aspect-video" : "aspect-square",
        )}
      >
        <Thumbnail
          thumbnails={item.thumbnails}
          alt={item.title}
          round={item.round}
          className={cn("size-full", radiusClass)}
          targetSize={isVideo ? 480 : 256}
          highRes
        />
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 border border-hairline",
            radiusClass,
          )}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            item.round && "justify-center",
          )}
        >
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.explicit ? (
            <span
              title="Explicit"
              aria-label="Explicit"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-bold leading-none text-muted-foreground"
            >
              E
            </span>
          ) : null}
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
          "group relative flex h-14 w-full items-center gap-3 overflow-hidden rounded-lg border-l-4 bg-white/5 px-3 transition-transform hover:scale-[1.01] active:scale-[0.99]",
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
        <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium text-white">
          {item.title}
        </span>
        <ChevronRightIcon className="relative z-10 size-4 shrink-0 text-white/40" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg border border-white opacity-10 mix-blend-difference"
        />
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
      <Link
        to="/album/$id"
        params={{ id: item.id }}
        className={cn(CARD_CLASS, className)}
      >
        {body}
      </Link>
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

function PlaylistPinContextMenu({
  item,
  children,
}: {
  item: ShelfItem;
  children: ReactNode;
}) {
  const pinned = useIsPinned(item.id);
  const pin = usePinnedPlaylistsStore((s) => s.pin);
  const unpin = usePinnedPlaylistsStore((s) => s.unpin);

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
      </ContextMenuContent>
    </ContextMenu>
  );
}
