import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ListMusicIcon,
  PlayIcon,
  PauseIcon,
  Volume2Icon,
  XIcon,
  Trash2Icon,
  RadioIcon,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
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
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-1">
        {/* The tabs already provide a built-in underline; override its
            own border-b so it doesn't double up with the header's
            bottom hairline. The header padding is also reduced
            (`py-1`) to leave room for the tab labels. */}
        <AnimatedTabs
          activeTab={tab}
          onChange={(id) => setTab(id as Tab)}
          variant="underline"
          className="border-b-0 [&_button]:px-3 [&_button]:py-2 [&_button]:text-sm"
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
                className={cn(autoRadio && "text-brand")}
              >
                <RadioIcon />
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
              >
                <Trash2Icon />
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
                >
                  <XIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-2">
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
    return (
      <p className="mt-4 px-2 text-sm text-muted-foreground">
        Queue is empty.
      </p>
    );
  }

  return (
    <>
      {active && (
        <QueueSection label="Now playing">
          <QueueRow track={active} active playing={playing} onActivate={onToggle} />
        </QueueSection>
      )}

      {upcoming.length > 0 ? (
        <>
          {active && <div className="h-4" aria-hidden="true" />}
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
                      onMoveTrack(dragFrom, queueIdx);
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
        <p className="mt-4 px-2 text-sm text-muted-foreground">
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
    return (
      <p className="mt-4 px-2 text-sm text-muted-foreground">
        No history yet.
      </p>
    );
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
          className={cn(open && "text-brand")}
        >
          <ListMusicIcon />
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
export function QueuePopover() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Queue">
              <ListMusicIcon />
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
          "px-2 py-1 text-xs font-semibold uppercase tracking-wide",
          muted ? "text-muted-foreground/70" : "text-muted-foreground",
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
        "group relative grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 outline-none",
        "cursor-pointer select-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent" : "hover:bg-accent/60",
        isDragging && "opacity-40",
        isDropTarget &&
          "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-brand",
      )}
    >
      {/* `pointer-events-none` — the inner <img> is `draggable` by
          default in every browser, which competes with the row's own
          drag (the user grabs the cover, the browser starts a native
          image-drag instead of our row reorder). Disabling pointer
          events on the wrapper makes the thumbnail transparent to
          mouse/drag events, so they bubble straight to the row. */}
      <div className="pointer-events-none relative size-10 shrink-0 overflow-hidden rounded-md">
        <Thumbnail
          thumbnails={track.thumbnails}
          alt={track.title}
          className="size-10"
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
              <Volume2Icon className="size-4 group-hover:hidden" />
              <PauseIcon className="hidden size-4 fill-current group-hover:block" />
            </>
          ) : (
            overlayIcon
          )}
        </span>
        {/* Adaptive hairline — last in DOM so it stays on top of the
            hover overlay; the difference blend keeps it readable
            against both the cover and the bg-black/50 hover wash. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-md border border-white opacity-10 mix-blend-difference"
        />
      </div>

      <div className="flex min-w-0 flex-col text-left">
        <span
          className={cn(
            "truncate text-sm font-medium",
            active && "text-brand",
          )}
        >
          {track.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </div>

      {/* Duration + remove. The remove button has zero width by
          default — `w-0 overflow-hidden opacity-0` — and animates to
          `w-6 + ml-1` on row hover, sliding in from the right and
          pushing the duration leftwards instead of being permanently
          reserved space that's just invisible. */}
      <div className="flex items-center">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatDuration(track.duration)}
        </span>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove from queue"
            className="w-0 overflow-hidden opacity-0 transition-[width,opacity,margin] duration-150 group-hover:ml-1 group-hover:w-6 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
