import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, MicVocalIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import {
  SOURCE_LABELS,
  SOURCE_ORDER,
  useLyricsSources,
  type LyricsSource,
} from "@/lib/lyrics/sources";
import { usePlaybackStore } from "@/lib/store/playback";
import type { QueueTrack } from "@/lib/store/playback";
import { cn } from "@/lib/utils";

const PREF_KEY = "ytm:lyrics-source";

type Pref = LyricsSource | "auto";
type Availability = "lrc" | "plain" | "loading" | "none";

function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (
      v === "lrclib" ||
      v === "musixmatch" ||
      v === "genius" ||
      v === "auto"
    ) {
      return v as Pref;
    }
  } catch {
    /* noop */
  }
  return "auto";
}

function savePref(p: Pref) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* noop */
  }
}

/**
 * Per-track lyric sync nudge, persisted as a videoId to seconds map.
 * Needed because the streamed audio is sometimes a different edit than
 * the one the lyric timings were cut to (a music video vs the album
 * track), so the lines run ahead of or behind the vocal by a constant
 * per-song amount that no global setting can fix. Positive = lyrics
 * fire later.
 */
const OFFSETS_KEY = "ytm:lyrics-offsets";
const OFFSET_STEP_S = 0.25;
const OFFSET_LIMIT_S = 15;
/** Soft cap on stored offsets; oldest-touched entries get trimmed
 *  first (JS objects iterate in insertion order, same trick the
 *  track-source store uses for its byVideoId map). */
const MAX_OFFSET_ENTRIES = 500;

function loadOffsetMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(OFFSETS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, number>;
    }
  } catch {
    /* corrupted entry, start fresh */
  }
  return {};
}

function loadOffset(videoId: string): number {
  const v = loadOffsetMap()[videoId];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function saveOffset(videoId: string, seconds: number): void {
  try {
    const map = loadOffsetMap();
    // Delete-then-set moves the key to the end of insertion order, so
    // the cap below always evicts the least recently adjusted tracks.
    delete map[videoId];
    if (seconds !== 0) map[videoId] = seconds;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_OFFSET_ENTRIES))) {
      delete map[k];
    }
    localStorage.setItem(OFFSETS_KEY, JSON.stringify(map));
  } catch {
    /* noop */
  }
}

function formatOffset(seconds: number): string {
  if (seconds === 0) return "0s";
  const trimmed = seconds.toFixed(2).replace(/\.?0+$/, "");
  return `${seconds > 0 ? "+" : ""}${trimmed}s`;
}

export type LyricsViewState = {
  active: Lyrics | null;
  isLoading: boolean;
  hasTrack: boolean;
  pref: Pref;
  setPref: (p: Pref) => void;
  best: LyricsSource | null;
  availability: Record<LyricsSource, Availability>;
  /** Per-track sync nudge in seconds; positive = lyrics fire later. */
  offset: number;
  nudgeOffset: (deltaSeconds: number) => void;
  resetOffset: () => void;
};

/**
 * Drives the inline lyrics panel: fires queries to all three sources,
 * tracks the user's source preference, and exposes a render-ready
 * state. Auto-pick rule: any timed source > any plain source, ordered
 * by `SOURCE_ORDER`.
 *
 * Used by the player bar to render `<LyricsBody>` (the flowing area)
 * and `<LyricsSourceButton>` (the mic-icon dropdown) from the same
 * state — without running the underlying queries twice.
 */
export function useLyricsView(track: QueueTrack | undefined): LyricsViewState {
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  const videoId = track?.videoId;
  const [offset, setOffsetState] = useState<number>(() =>
    videoId ? loadOffset(videoId) : 0,
  );
  useEffect(() => {
    setOffsetState(videoId ? loadOffset(videoId) : 0);
  }, [videoId]);
  const nudgeOffset = (deltaSeconds: number) => {
    if (!videoId) return;
    // Round to the step grid so repeated float adds can't drift into
    // 0.7500000000000001-style labels.
    const raw = offset + deltaSeconds;
    const next = Math.max(
      -OFFSET_LIMIT_S,
      Math.min(
        OFFSET_LIMIT_S,
        Math.round(raw / OFFSET_STEP_S) * OFFSET_STEP_S,
      ),
    );
    setOffsetState(next);
    saveOffset(videoId, next);
  };
  const resetOffset = () => {
    if (!videoId) return;
    setOffsetState(0);
    saveOffset(videoId, 0);
  };

  const { queries, best, isLoading } = useLyricsSources(track, !!track);

  const availability = useMemo(() => {
    const acc = {} as Record<LyricsSource, Availability>;
    for (const s of SOURCE_ORDER) {
      const q = queries[s];
      acc[s] = q.data
        ? q.data.kind === "timed"
          ? "lrc"
          : "plain"
        : q.isLoading
          ? "loading"
          : "none";
    }
    return acc;
  }, [queries]);

  const activeSource: LyricsSource | null = pref === "auto" ? best : pref;
  const active = activeSource ? (queries[activeSource].data ?? null) : null;

  return {
    active,
    isLoading,
    hasTrack: !!track,
    pref,
    setPref,
    best,
    availability,
    offset,
    nudgeOffset,
    resetOffset,
  };
}

export function LyricsBody({
  state,
  viewportRatio,
}: {
  state: LyricsViewState;
  /** Where the active line rests, as a fraction of viewport height.
   *  Defaults to the inline-panel value; the fullscreen player passes a
   *  lower-center ratio for its taller canvas. */
  viewportRatio?: number;
}) {
  if (!state.hasTrack) return null;
  if (state.isLoading && !state.active) {
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        Loading lyrics…
      </p>
    );
  }
  if (!state.active) {
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        No lyrics found.
      </p>
    );
  }
  if (state.active.kind === "timed") {
    return (
      <TimedLyrics
        lines={state.active.lines}
        offset={state.offset}
        onNudge={state.nudgeOffset}
        onReset={state.resetOffset}
        viewportRatio={viewportRatio}
      />
    );
  }
  return <PlainLyrics text={state.active.text} />;
}

/** How long before a line's actual start time we flip it to active.
 *  Kept small so the highlight lands almost on the vocal instead of
 *  jumping ahead by the better part of a second. At the flip the
 *  previous line's CSS transition starts fading it out and the new
 *  line's starts fading in; the `duration-*` value on the line element
 *  sets that cross-fade a touch longer than this lookahead so the
 *  handoff still feels smooth rather than crisp. */
const ACTIVE_LOOKAHEAD_S = 0.2;

function findActiveIdx(lines: TimedLine[], position: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].start - ACTIVE_LOOKAHEAD_S;
    if (start > position) break;
    const nextStart = lines[i + 1]?.start;
    const end =
      nextStart !== undefined
        ? nextStart - ACTIVE_LOOKAHEAD_S
        : (lines[i].end ?? Infinity);
    if (position < end) {
      active = i;
      break;
    }
    active = i;
  }
  return active;
}

/** How far from the top of the viewport the active line should sit,
 *  as a fraction of the visible height. 0.5 = perfectly centered;
 *  0.45 keeps it just above dead center so a little more upcoming text
 *  stays in view while the active line still reads as centered. */
const ACTIVE_LINE_VIEWPORT_RATIO = 0.45;

/** Duration of the auto-scroll that re-centers the active line.
 *  Native `scrollTo({ behavior: "smooth" })` is non-configurable in
 *  Chromium (~300 ms regardless of distance), which feels jumpy on
 *  long jumps — we drive the scroll ourselves with rAF instead. */
const SCROLL_DURATION_MS = 720;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function TimedLyrics({
  lines,
  offset,
  onNudge,
  onReset,
  viewportRatio = ACTIVE_LINE_VIEWPORT_RATIO,
}: {
  lines: TimedLine[];
  offset: number;
  onNudge: (deltaSeconds: number) => void;
  onReset: () => void;
  viewportRatio?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const position = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);

  // Positive offset = lyrics fire later, i.e. the playhead is treated
  // as being earlier in the song. Kept in a ref too so the mount-snap
  // effect below (deps: [lines]) reads the current value without
  // re-snapping on every nudge.
  const activeIdx = findActiveIdx(lines, position - offset);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const prevActiveRef = useRef(activeIdx);

  // On mount and whenever the lyric set changes (new track), snap the
  // active line into view without animation. Without this the animated
  // effect below never fires on mount (prevActiveRef starts equal to the
  // initial activeIdx), so opening the panel mid-song — or skipping tracks
  // while it stays mounted — leaves the active line off-screen / stale.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const idx = findActiveIdx(
      lines,
      usePlaybackStore.getState().position - offsetRef.current,
    );
    prevActiveRef.current = idx;
    if (idx < 0) {
      container.scrollTop = 0;
      return;
    }
    const el = container.querySelector<HTMLElement>(
      `[data-line-idx="${idx}"]`,
    );
    if (!el) {
      container.scrollTop = 0;
      return;
    }
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const elTopWithinContent = eRect.top - cRect.top + container.scrollTop;
    const target =
      idx === 0
        ? 0
        : container.clientHeight * viewportRatio - el.clientHeight / 2;
    container.scrollTop = Math.max(0, elTopWithinContent - target);
  }, [lines]);

  useEffect(() => {
    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-line-idx="${activeIdx}"]`,
    );
    if (!el) return;
    // Position the active line above center so more upcoming lines stay
    // visible. getBoundingClientRect avoids depending on offsetParent.
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const elTopWithinContent =
      eRect.top - cRect.top + container.scrollTop;
    // The very first line is treated as a special case: we pin it to
    // the top of the viewport instead of the usual ~45% position. For
    // any later line, the active-line-above-center rule applies.
    const target =
      activeIdx === 0
        ? 0
        : container.clientHeight * viewportRatio - el.clientHeight / 2;
    const targetTop = Math.max(0, elTopWithinContent - target);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;

    const startTs = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / SCROLL_DURATION_MS);
      container.scrollTop = startTop + delta * easeInOutCubic(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [activeIdx]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className={cn(
          "lyrics-no-scrollbar flex h-full flex-col gap-1 overflow-y-auto px-1 pt-0 pb-16",
          // Mask kicks in only after the karaoke has moved past the
          // first line — that way the first line stays crisp at the
          // top of the column while the song hasn't started or is on
          // line 0.
          activeIdx >= 1 && "lyrics-mask",
        )}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <button
              key={i}
              type="button"
              data-line-idx={i}
              onClick={() => seek(line.start + offset)}
              className={cn(
                // Same font-size on every line so the active line can't
                // grow into a second row and shove neighbours around.
                // The "active is bigger" feel comes from a transform
                // scale (off the layout flow) plus weight + glow.
                //
                // Cross-fade duration is a touch longer than
                // `ACTIVE_LOOKAHEAD_S` (800 ms) so the highlight is
                // well past the midpoint by the time the new line
                // actually starts, but still feels deliberate rather
                // than abrupt. ease-in-out softens both ends.
                // `scale` lives on its own CSS property in Tailwind v4
                // (not `transform`), so it's listed explicitly in the
                // transition. Both branches set a `scale-*` so the
                // browser has a defined start AND end to interpolate.
                "lyrics-line origin-left cursor-pointer rounded-md px-2 py-1 text-left text-lg font-[650] leading-snug transition-[scale,color] duration-[1260ms] ease-in-out hover:bg-black/30",
                isActive
                  ? "scale-[1.06] text-foreground"
                  : isPast
                    ? "scale-100 text-muted-foreground/40"
                    : "scale-100 text-muted-foreground/70",
              )}
            >
              {line.text || "♪"}
            </button>
          );
        })}
      </div>
      {/* Static blur overlay — sits over the top of the lyrics column
          and applies `backdrop-filter` to whatever is visually behind
          it. Lines passing through the strip appear blurred, but the
          blur travels with the viewport, not the content — so when the
          user manually scrolls up to find an earlier line, that line
          becomes clear as it leaves the blurred strip.
          When the very first line is active it sits at viewport top
          (no above-center offset), so we fade the overlay out to keep
          the first line crisp. */}
      <div
        aria-hidden
        className="lyrics-blur-overlay pointer-events-none absolute inset-x-0 top-0 h-[26%] transition-opacity duration-500 ease-in-out"
        style={{ opacity: activeIdx <= 0 ? 0 : 1 }}
      />
      {/* Sync nudge, floats over the faded bottom edge of the column.
          Nudges the highlight in 0.25s steps for tracks whose audio is
          a different edit than the lyric timings (music video vs album
          cut). Clicking the readout resets to 0. */}
      <div className="absolute bottom-2 right-1 z-10 flex items-center gap-0.5 rounded-full border border-hairline bg-surface-active/70 px-1 py-0.5 opacity-60 backdrop-blur-md transition-opacity hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Lyrics earlier"
              onClick={() => onNudge(-OFFSET_STEP_S)}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <MinusIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Lyrics earlier</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Reset lyrics offset"
              onClick={onReset}
              className="min-w-11 text-center text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            >
              {formatOffset(offset)}
            </button>
          </TooltipTrigger>
          <TooltipContent>Sync offset (click to reset)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Lyrics later"
              onClick={() => onNudge(OFFSET_STEP_S)}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Lyrics later</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function PlainLyrics({ text }: { text: string }) {
  return (
    <div className="lyrics-mask app-scroll h-full overflow-y-auto whitespace-pre-wrap px-2 pt-0 pb-12 text-lg font-medium leading-relaxed text-foreground/90">
      {text}
    </div>
  );
}

export function LyricsSourceButton({
  state,
  className,
}: {
  state: LyricsViewState;
  className?: string;
}) {
  const { pref, setPref, best, availability } = state;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Lyrics source"
              className={className}
            >
              <MicVocalIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Lyrics source</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Lyrics source</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setPref("auto")}>
          <span className="flex-1">
            Auto
            {best ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({SOURCE_LABELS[best]})
              </span>
            ) : null}
          </span>
          {pref === "auto" ? <CheckIcon className="size-4" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SOURCE_ORDER.map((s) => {
          const a = availability[s];
          const dot =
            a === "lrc"
              ? "bg-brand"
              : a === "plain"
                ? "bg-muted-foreground/60"
                : a === "loading"
                  ? "bg-muted-foreground/30 animate-pulse"
                  : "bg-transparent";
          return (
            <DropdownMenuItem
              key={s}
              onSelect={() => setPref(s)}
              disabled={a === "none"}
            >
              <span
                className={cn("mr-2 size-1.5 shrink-0 rounded-full", dot)}
              />
              <span className="flex-1">{SOURCE_LABELS[s]}</span>
              {pref === s ? <CheckIcon className="size-4" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
