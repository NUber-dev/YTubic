import { memo, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PlayIcon, PauseIcon, Volume2Icon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Thumbnail } from "@/components/shared/thumbnail";
import {
  TrackContextMenu,
  TrackMoreMenu,
  type PlaylistRemovalContext,
} from "@/components/shared/track-context-menu";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { cn } from "@/lib/utils";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useTrackSourceStore } from "@/lib/store/track-source";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  tracks: ShelfItem[];
  /** Hide the thumbnail column (useful on album pages where art is repeated). */
  hideThumbnails?: boolean;
  /** Hide the album column. */
  hideAlbum?: boolean;
  /** Replace the Duration column with Plays. Used on artist Top Songs
   *  where YT doesn't ship duration in the shelf payload but does
   *  ship a play count. */
  showPlays?: boolean;
  /** Enables "Remove from playlist" on rows; set only by an editable
   *  (user-owned) playlist page. */
  removal?: PlaylistRemovalContext;
  /**
   * Render all rows directly instead of windowing them. For short
   * secondary lists (e.g. playlist Suggestions): the virtualizer anchors
   * to the app scroller with a scrollMargin measured once per
   * tracks-change, so a list sitting BELOW other growing content (infinite
   * scroll) would keep a stale offset and window the wrong rows.
   */
  virtualize?: boolean;
  className?: string;
};

// Height of a row plus the explicit 2px gap below it
// (p-2 + 40px thumb + 2px spacing). The virtualizer
// also measures actual rendered rows via `measureElement`, so a slight
// mismatch only affects the initial scroll-bar size before measurements
// settle.
const ROW_SIZE = 58;

function formatDuration(seconds?: number): string {
  if (!seconds || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Compact a numeric play-count string like "1,234,567" into "1.2M".
 * If the input already has a suffix (e.g. "1.2M plays") or is non-
 * numeric, return it untouched — YT often pre-formats these in
 * locale-aware ways and we don't want to mangle that.
 */
function formatPlays(text?: string): string {
  if (!text) return "—";
  const trimmed = text.trim();
  if (!/^[\d.,\s]+$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n === 0) return trimmed;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function ExplicitBadge() {
  return (
    <span
      title="Explicit"
      aria-label="Explicit"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-bold leading-none text-muted-foreground"
    >
      E
    </span>
  );
}

function VideoSourceBadge() {
  return (
    <span
      title="Playing the video version"
      aria-label="Video source"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-brand/15 text-[10px] font-bold leading-none text-brand"
    >
      V
    </span>
  );
}

export function TrackList({
  tracks,
  hideThumbnails = false,
  hideAlbum = false,
  showPlays = false,
  removal,
  virtualize = true,
  className,
}: Props) {
  const active = usePlaybackStore(currentTrack);
  const playing = usePlaybackStore((s) => s.playing);
  const sourcePrefs = useTrackSourceStore((s) => s.byVideoId);

  // Resolve the app's scroll container (`<main class="app-scroll">`) so
  // the virtualizer can listen to its scroll events. Done in an effect
  // because the element doesn't exist during the very first render of
  // route-level components mounted under <Suspense>.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setScrollEl(document.querySelector<HTMLElement>("main.app-scroll"));
  }, []);

  // The virtualized list lives inside route content (header, sort menu,
  // …) above it. `scrollMargin` tells the virtualizer how far down the
  // scroller the list begins so visible-row math stays correct. We
  // recompute it whenever the scroller resolves or anything above the
  // list changes height (cover image loads, description expands, …).
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const compute = () => {
      const list = listRef.current;
      if (!list) return;
      const listTop = list.getBoundingClientRect().top;
      const scrollerTop = scrollEl.getBoundingClientRect().top;
      setScrollMargin(listTop - scrollerTop + scrollEl.scrollTop);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(scrollEl);
    // Also observe the immediate parent (route content) so header
    // expansions trigger a recompute. Falls back to scroll listener.
    if (listRef.current?.parentElement)
      ro.observe(listRef.current.parentElement);
    return () => ro.disconnect();
  }, [scrollEl, tracks.length]);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_SIZE,
    overscan: 8,
    scrollMargin,
    getItemKey: (i) => `${tracks[i].id}:${i}`,
  });

  const showAlbum = !hideAlbum && tracks.some((t) => t.album);

  // Grid template shared by the header row and every track row so the
  // columns line up in a real "table" layout.
  // Duration and Actions use FIXED widths so the header grid and the
  // row grids agree on column boundaries — `auto` would let each
  // container size the column to its own content (e.g. the word
  // "Duration" vs. "3:32") and the columns would visually drift apart.
  const gridTemplate = [
    "minmax(0,2fr)", // TRACK (thumb/index + title) — 2x weight so long
    // titles get the breathing room before truncation
    "minmax(0,1fr)", // ARTIST
    showAlbum ? "minmax(0,1fr)" : null, // ALBUM
    showPlays ? "5rem" : "3.5rem", // DURATION or PLAYS — plays is wider
    "4rem", // ACTIONS (heart + more)
  ]
    .filter(Boolean)
    .join(" ");

  if (tracks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No tracks to display.</p>
    );
  }

  if (!virtualize) {
    return (
      <div className={cn("flex flex-col", className)}>
        {tracks.map((t, idx) => (
          <div key={`${t.id}:${idx}`} style={{ paddingBottom: 2 }}>
            <TrackRow
              track={t}
              idx={idx}
              tracks={tracks}
              gridTemplate={gridTemplate}
              hideThumbnails={hideThumbnails}
              showAlbum={showAlbum}
              showPlays={showPlays}
              isActive={active?.videoId === t.id}
              playing={playing}
              videoSourceSelected={sourcePrefs[t.id]?.selected === "video"}
              removal={removal}
            />
          </div>
        ))}
      </div>
    );
  }

  // If the active track is in this list but its row isn't in the
  // virtual window, JumpToCurrentButton can't find `[data-videoid=…]`
  // via querySelector. Render a hidden zero-content marker at the
  // active row's absolute Y position so the existing scroll-into-view
  // logic keeps working without coupling JumpToCurrent to the
  // virtualizer.
  const activeIndex = active
    ? tracks.findIndex((t) => t.id === active.videoId)
    : -1;
  const items = virtualizer.getVirtualItems();
  const activeInWindow =
    activeIndex >= 0 && items.some((vi) => vi.index === activeIndex);

  return (
    <div className={cn("flex flex-col", className)}>
      <div
        ref={listRef}
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {activeIndex >= 0 && !activeInWindow ? (
          <div
            aria-hidden
            data-videoid={active!.videoId}
            style={{
              position: "absolute",
              top: activeIndex * ROW_SIZE,
              left: 0,
              right: 0,
              height: ROW_SIZE,
              visibility: "hidden",
              pointerEvents: "none",
            }}
          />
        ) : null}
        {items.map((vi) => {
          const t = tracks[vi.index];
          const idx = vi.index;
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={idx}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                paddingBottom: 2,
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <TrackRow
                track={t}
                idx={idx}
                tracks={tracks}
                gridTemplate={gridTemplate}
                hideThumbnails={hideThumbnails}
                showAlbum={showAlbum}
                showPlays={showPlays}
                isActive={active?.videoId === t.id}
                playing={playing}
                videoSourceSelected={sourcePrefs[t.id]?.selected === "video"}
                removal={removal}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type RowProps = {
  track: ShelfItem;
  idx: number;
  tracks: ShelfItem[];
  gridTemplate: string;
  hideThumbnails: boolean;
  showAlbum: boolean;
  showPlays: boolean;
  isActive: boolean;
  playing: boolean;
  videoSourceSelected: boolean;
  removal?: PlaylistRemovalContext;
};

const TrackRow = memo(function TrackRow({
  track: t,
  idx,
  tracks,
  gridTemplate,
  hideThumbnails,
  showAlbum,
  showPlays,
  isActive,
  playing,
  videoSourceSelected,
  removal,
}: RowProps) {
  const row = (
    <li
      data-videoid={t.id}
      style={{ gridTemplateColumns: gridTemplate }}
      className={cn(
        "group grid cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors",
        isActive ? "bg-black/25" : "hover:bg-accent/60",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        const store = usePlaybackStore.getState();
        if (isActive) store.toggle();
        else store.playShelfItems(tracks, idx);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const store = usePlaybackStore.getState();
          if (isActive) store.toggle();
          else store.playShelfItems(tracks, idx);
        }
      }}
      tabIndex={0}
      role="button"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center">
          {hideThumbnails ? (
            <>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isActive
                    ? "hidden"
                    : "text-muted-foreground group-hover:hidden",
                  isActive ? "text-brand" : "",
                )}
              >
                {idx + 1}
              </span>
              {isActive ? (
                playing ? (
                  <Volume2Icon className="size-4 text-brand" />
                ) : (
                  <PauseIcon className="size-4 text-brand" />
                )
              ) : (
                <PlayIcon
                  className="hidden size-4 fill-current group-hover:block"
                  aria-hidden
                />
              )}
            </>
          ) : (
            <div className="relative size-10">
              <Thumbnail
                thumbnails={t.thumbnails}
                alt={t.title}
                className="size-full rounded-sm"
                targetSize={80}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-sm border border-white opacity-10 mix-blend-difference"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm bg-black/55 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              >
                {isActive && playing ? (
                  <PauseIcon className="size-5 fill-current text-white" />
                ) : (
                  <PlayIcon className="size-5 fill-current text-white" />
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              isActive && "text-brand font-bold",
            )}
          >
            {t.title}
          </span>
          {t.explicit ? <ExplicitBadge /> : null}
          {videoSourceSelected ? <VideoSourceBadge /> : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
        {t.artists?.length ? (
          t.artists.map((a, i) => (
            <span key={`${a.id ?? a.name}-${i}`} className="truncate">
              {a.id ? (
                <Link
                  to="/artist/$id"
                  params={{ id: a.id }}
                  className="hover:text-foreground hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {a.name}
                </Link>
              ) : (
                a.name
              )}
              {i < (t.artists?.length ?? 0) - 1 ? ", " : ""}
            </span>
          ))
        ) : (
          <span className="truncate">{t.subtitle ?? ""}</span>
        )}
      </div>

      {showAlbum ? (
        <div className="min-w-0 truncate text-sm text-muted-foreground">
          {t.album ? (
            t.albumId ? (
              <Link
                to="/album/$id"
                params={{ id: t.albumId }}
                className="truncate hover:text-foreground hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {t.album}
              </Link>
            ) : (
              <span className="truncate">{t.album}</span>
            )
          ) : null}
        </div>
      ) : null}

      <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {showPlays ? formatPlays(t.playCount) : formatDuration(t.duration)}
      </span>

      <div className="flex shrink-0 items-center justify-end">
        <LikeDislikeButtons videoId={t.id} track={t} compact hideUnlessLiked />
        <TrackMoreMenu
          item={t}
          context={{ tracks, index: idx }}
          removal={removal}
        />
      </div>
    </li>
  );

  return (
    <TrackContextMenu
      item={t}
      context={{ tracks, index: idx }}
      removal={removal}
    >
      {row}
    </TrackContextMenu>
  );
});
