import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
// Transport glyphs stay Lucide, as everywhere else in the player; the
// chrome around them is Tabler.
import { PlayIcon, PauseIcon } from "lucide-react";
import {
  IconBroadcast,
  IconPlaylist,
  IconTrashFilled,
  IconX,
} from "@tabler/icons-react";
import { IconVolumeFilled } from "@/components/shared/filled-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  playerIconButton,
  playerIconButtonOn,
} from "@/components/layout/player-chrome";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { Thumbnail } from "@/components/shared/thumbnail";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { cn } from "@/lib/utils";

function formatDuration(seconds?: number): string {
  if (!seconds || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Tab = "queue" | "history";

/**
 * The scrolling list.
 *
 * The fade at the bottom edge is a mask on the viewport, not an overlay,
 * so it works over the card's translucent glass without having to match
 * a background colour. The list's own `pb-7` matches the fade height:
 * scrolled all the way down the band lands on that padding instead of
 * eating the last row.
 *
 * The scrollbar is slimmed down from the app-wide 10px — this list is
 * narrow and the default bar took a visible bite out of the rows.
 */
const QUEUE_SCROLL = cn(
  "min-h-0 flex-1",
  "[&_[data-slot=scroll-area-viewport]]:[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)]",
  "[&_[data-slot=scroll-area-scrollbar]]:w-1.5",
  "[&_[data-slot=scroll-area-thumb]]:bg-w200",
);

/**
 * Pure queue contents — header (tabs + autoplay/clear/close actions)
 * plus a scrollable list whose contents depend on the active tab.
 * Has no outer chrome, so callers control the surface: an inline
 * overlay inside the player card (right/floating variants) or a
 * Popover anchored to the queue button (bottom-bar variant).
 */
export function QueueBody({ onClose }: { onClose?: () => void }) {
  const { queue, index, playing, autoRadio } = usePlaybackStore(
    useShallow((s) => ({
      queue: s.queue,
      index: s.index,
      playing: s.playing,
      autoRadio: s.autoRadio,
    })),
  );
  const active = usePlaybackStore(currentTrack);
  const goTo = usePlaybackStore((s) => s.goTo);
  const toggle = usePlaybackStore((s) => s.toggle);
  const removeAt = usePlaybackStore((s) => s.removeAt);
  const moveTrack = usePlaybackStore((s) => s.moveTrack);
  const clearQueue = usePlaybackStore((s) => s.clearQueue);
  const setAutoRadio = usePlaybackStore((s) => s.setAutoRadio);

  const upcoming = index >= 0 ? queue.slice(index + 1) : queue;
  const history = index > 0 ? queue.slice(0, index) : [];

  const [tab, setTab] = useState<Tab>("queue");

  // Drag-and-drop state for "Up next". Stores the absolute queue index
  // of the row being dragged and of the row currently being hovered.
  // Both are needed to render visual indicators (faded source row,
  // insertion-line on the target row).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-w055 px-2.5">
        {/* The tabs already provide a built-in underline; override its
            own border-b so it doesn't double up with the header's
            bottom hairline. The header carries no vertical padding of
            its own either — the tab buttons set its height, which is
            what lands the moving underline on the hairline instead of
            leaving it floating above. Labels drop to the menu's 13.5px
            and onto the text ramp; the component's own
            `text-foreground` pair predates the palette. */}
        <AnimatedTabs
          activeTab={tab}
          onChange={(id) => setTab(id as Tab)}
          variant="underline"
          className={cn(
            "border-b-0",
            "[&_button]:px-2.5 [&_button]:py-3 [&_button]:text-[13.5px]",
            "[&_button[aria-selected=false]]:text-t5 [&_button[aria-selected=false]]:hover:text-t3",
            "[&_button[aria-selected=true]]:font-semibold [&_button[aria-selected=true]]:text-t1",
          )}
          tabs={[
            { id: "queue", label: "Queue" },
            { id: "history", label: "History" },
          ]}
        />
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Autoplay"
                aria-pressed={autoRadio}
                onClick={() => setAutoRadio(!autoRadio)}
                className={cn(
                  playerIconButton,
                  autoRadio && playerIconButtonOn,
                )}
              >
                <IconBroadcast />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Autoplay</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Clear queue"
                disabled={queue.length === 0}
                onClick={clearQueue}
                className={playerIconButton}
              >
                <IconTrashFilled />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clear queue</TooltipContent>
          </Tooltip>
          {onClose && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close queue"
                  onClick={onClose}
                  className={playerIconButton}
                >
                  <IconX />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <ScrollArea className={QUEUE_SCROLL}>
        {/* Sections space themselves; the old hard-coded spacer between
            "Now playing" and "Up next" is this gap. */}
        <div className="flex flex-col gap-3 p-2 pb-7">
          {tab === "queue" ? (
            <QueueTabBody
              active={active}
              playing={playing}
              upcoming={upcoming}
              index={index}
              dragFrom={dragFrom}
              dragOver={dragOver}
              setDragFrom={setDragFrom}
              setDragOver={setDragOver}
              onToggle={toggle}
              onGoTo={goTo}
              onRemoveAt={removeAt}
              onMoveTrack={moveTrack}
            />
          ) : (
            <HistoryTabBody
              history={history}
              onGoTo={goTo}
              onRemoveAt={removeAt}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function QueueTabBody({
  active,
  playing,
  upcoming,
  index,
  dragFrom,
  dragOver,
  setDragFrom,
  setDragOver,
  onToggle,
  onGoTo,
  onRemoveAt,
  onMoveTrack,
}: {
  active: ReturnType<typeof currentTrack>;
  playing: boolean;
  upcoming: NonNullable<ReturnType<typeof currentTrack>>[];
  index: number;
  dragFrom: number | null;
  dragOver: number | null;
  setDragFrom: (v: number | null) => void;
  setDragOver: (v: number | null) => void;
  onToggle: () => void;
  onGoTo: (i: number) => void;
  onRemoveAt: (i: number) => void;
  onMoveTrack: (from: number, to: number) => void;
}) {
  if (!active && upcoming.length === 0) {
    return <p className="mt-3 px-2 text-[13.5px] text-t5">Queue is empty.</p>;
  }

  return (
    <>
      {active && (
        <QueueSection label="Now playing">
          <QueueRow
            track={active}
            active
            playing={playing}
            onActivate={onToggle}
          />
        </QueueSection>
      )}

      {upcoming.length > 0 ? (
        <>
          <QueueSection label="Up next">
            {upcoming.map((t, i) => {
              const queueIdx = index + 1 + i;
              return (
                <QueueRow
                  key={`u-${t.videoId}-${i}`}
                  track={t}
                  onActivate={() => onGoTo(queueIdx)}
                  onRemove={() => onRemoveAt(queueIdx)}
                  draggable
                  isDragging={dragFrom === queueIdx}
                  isDropTarget={dragOver === queueIdx && dragFrom !== queueIdx}
                  onDragStart={() => setDragFrom(queueIdx)}
                  onDragOver={() => {
                    if (dragFrom === null) return;
                    setDragOver(queueIdx);
                  }}
                  onDrop={() => {
                    if (dragFrom !== null && dragFrom !== queueIdx) {
                      // The drop indicator sits above the hovered row
                      // ("insert before it"). For a downward move, splicing
                      // the dragged item out first shifts the target down by
                      // one, so subtract one to land before the row, not
                      // after it (upward drags are already correct).
                      const to = dragFrom < queueIdx ? queueIdx - 1 : queueIdx;
                      onMoveTrack(dragFrom, to);
                    }
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                />
              );
            })}
          </QueueSection>
        </>
      ) : active ? (
        <p className="mt-3 px-2 text-[13.5px] text-t5">
          Nothing queued. Enable Autoplay to keep the music going.
        </p>
      ) : null}
    </>
  );
}

function HistoryTabBody({
  history,
  onGoTo,
  onRemoveAt,
}: {
  history: NonNullable<ReturnType<typeof currentTrack>>[];
  onGoTo: (i: number) => void;
  onRemoveAt: (i: number) => void;
}) {
  if (history.length === 0) {
    return <p className="mt-3 px-2 text-[13.5px] text-t5">No history yet.</p>;
  }
  return (
    <QueueSection label="Previously played" muted>
      {history.map((t, i) => (
        <QueueRow
          key={`h-${t.videoId}-${i}`}
          track={t}
          onActivate={() => onGoTo(i)}
          onRemove={() => onRemoveAt(i)}
        />
      ))}
    </QueueSection>
  );
}

/**
 * Toggle button for the inline queue overlay (right/floating PlayerBar).
 * Caller owns the open state and renders `<QueueBody>` next to the
 * player content when `open` is true.
 */
export function QueueToggleButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Queue"
          aria-pressed={open}
          onClick={onToggle}
          className={cn(playerIconButton, open && playerIconButtonOn)}
        >
          <IconPlaylist />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Queue</TooltipContent>
    </Tooltip>
  );
}

/**
 * Self-contained queue button + Popover for the bottom bar variant.
 * Top-anchored, centered on the trigger button so the popover sits
 * symmetrically around it (Radix's collision detection slides it left
 * if the right edge would overflow the viewport). Fixed 28rem×28rem.
 */
export function QueuePopover({ className }: { className?: string }) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Queue"
              className={cn(playerIconButton, className)}
            >
              <IconPlaylist />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Queue</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="center"
        side="top"
        sideOffset={12}
        className="flex h-[28rem] w-[28rem] flex-col p-0"
      >
        <QueueBody />
      </PopoverContent>
    </Popover>
  );
}

function QueueSection({
  label,
  children,
  muted = false,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3
        className={cn(
          "px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.09em]",
          muted ? "text-t7" : "text-t5",
        )}
      >
        {label}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function QueueRow({
  track,
  active = false,
  playing = false,
  onActivate,
  onRemove,
  draggable = false,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  track: {
    videoId: string;
    title: string;
    subtitle?: string;
    thumbnails: any[];
    artists?: { name: string }[];
    duration?: number;
  };
  active?: boolean;
  playing?: boolean;
  onActivate: () => void;
  onRemove?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  const subtitle =
    track.artists?.map((a) => a.name).join(", ") ?? track.subtitle ?? "";

  // Pick which thumbnail-overlay icon to show. For non-active rows the
  // overlay only appears on hover (Play). For the active row the
  // overlay is always visible and mirrors the *action* the click will
  // perform — Pause when currently playing, Play when paused —
  // matching the row-wide click → toggle behavior.
  const overlayIcon = active ? (
    playing ? (
      <PauseIcon className="size-4 fill-current" />
    ) : (
      <PlayIcon className="size-4 fill-current" />
    )
  ) : (
    <PlayIcon className="size-4 fill-current" />
  );

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      onDragStart={(e) => {
        if (!draggable) return;
        // Some browsers refuse to start a drag without dataTransfer payload.
        e.dataTransfer.setData("text/plain", track.videoId);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver?.();
      }}
      onDrop={(e) => {
        if (!draggable) return;
        e.preventDefault();
        onDrop?.();
      }}
      onDragEnd={() => {
        if (!draggable) return;
        onDragEnd?.();
      }}
      className={cn(
        "group relative grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none",
        "cursor-pointer select-none transition-colors duration-[140ms]",
        "focus-visible:ring-[3px] focus-visible:ring-[rgba(var(--acc1rgb),0.18)]",
        active ? "bg-w070" : "hover:bg-w050",
        isDragging && "opacity-40",
        isDropTarget &&
          "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-acc1",
      )}
    >
      {/* `pointer-events-none` — the inner <img> is `draggable` by
          default in every browser, which competes with the row's own
          drag (the user grabs the cover, the browser starts a native
          image-drag instead of our row reorder). Disabling pointer
          events on the wrapper makes the thumbnail transparent to
          mouse/drag events, so they bubble straight to the row. */}
      <div className="pointer-events-none relative size-9 shrink-0 overflow-hidden rounded-[7px]">
        <Thumbnail
          thumbnails={track.thumbnails}
          alt={track.title}
          className="size-9"
          targetSize={80}
        />
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-black/50 text-white",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {/* Active+playing also shows the speaker glyph at rest as a
              state indicator; on hover we swap to the Pause icon to
              make the click action obvious. */}
          {active && playing ? (
            <>
              <IconVolumeFilled className="size-4 group-hover:hidden" />
              <PauseIcon className="hidden size-4 fill-current group-hover:block" />
            </>
          ) : (
            overlayIcon
          )}
        </span>
        {/* Last in DOM so the hairline stays on top of the hover overlay;
            the difference blend keeps it readable against both the cover
            and the bg-black/50 hover wash. */}
        <ArtworkOutline className="rounded-[7px]" />
      </div>

      <div className="flex min-w-0 flex-col text-left">
        <span
          className={cn(
            "truncate text-[13.5px]",
            active ? "font-semibold text-acc1" : "font-medium text-t2",
          )}
        >
          {track.title}
        </span>
        <span className="truncate text-[12px] leading-snug text-t6">
          {subtitle}
        </span>
      </div>

      {/* Duration + remove. The remove button has zero width by
          default — `w-0 overflow-hidden opacity-0` — and animates to
          `w-6 + ml-1` on row hover, sliding in from the right and
          pushing the duration leftwards instead of being permanently
          reserved space that's just invisible. */}
      <div className="flex items-center">
        <span className="text-[12px] tabular-nums text-t7">
          {formatDuration(track.duration)}
        </span>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove from queue"
            className="w-0 overflow-hidden text-t6 opacity-0 transition-[width,opacity,margin] duration-150 hover:bg-w090 hover:text-t1 group-hover:ml-1 group-hover:w-6 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <IconX />
          </Button>
        )}
      </div>
    </div>
  );
}
