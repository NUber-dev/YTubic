import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, MicVocalIcon, RotateCwIcon } from "lucide-react";
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
import { useScrubStore } from "@/lib/store/scrub";
import { cn } from "@/lib/utils";

const PREF_KEY = "ytm:lyrics-source";

type Pref = LyricsSource | "auto";
/** "none" means the source answered and has nothing. "error" means it never
 *  answered. Keeping them apart is the whole point of the provider change:
 *  an unreachable source must stay selectable so the user can retry it. */
type Availability = "lrc" | "plain" | "loading" | "none" | "error";

function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "auto") return "auto";
    // Checked against SOURCE_ORDER rather than a hardcoded list of names.
    // The list version silently dropped any source added later: pinning
    // one and restarting reverted you to "auto" with no explanation.
    if (v && (SOURCE_ORDER as string[]).includes(v)) return v as Pref;
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

export type LyricsViewState = {
  active: Lyrics | null;
  isLoading: boolean;
  hasTrack: boolean;
  pref: Pref;
  setPref: (p: Pref) => void;
  best: LyricsSource | null;
  availability: Record<LyricsSource, Availability>;
  /** Sources that failed to answer at all. */
  failed: LyricsSource[];
  /** A retry is in flight. */
  isRetrying: boolean;
  retryFailed: () => void;
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

  const { queries, best, isLoading, failed, isRetrying, retryFailed } =
    useLyricsSources(track, !!track);

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
          : q.isError
            ? "error"
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
    failed,
    isRetrying,
    retryFailed,
  };
}

export function LyricsBody({ state }: { state: LyricsViewState }) {
  if (!state.hasTrack) return null;
  if (state.isLoading && !state.active) {
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        Loading lyrics…
      </p>
    );
  }
  if (!state.active) {
    // A source that never answered is not a track without lyrics. Say which
    // it was and offer another go, rather than the flat "No lyrics found."
    // that used to cover both and then sat in the disk cache for 24h.
    if (state.failed.length > 0) {
      return (
        <div className="flex flex-col items-start gap-2 px-4 py-2">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t reach{" "}
            {state.failed.map((s) => SOURCE_LABELS[s]).join(", ")}.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={state.retryFailed}
            disabled={state.isRetrying}
          >
            <RotateCwIcon className={state.isRetrying ? "animate-spin" : ""} />
            {state.isRetrying ? "Trying…" : "Try again"}
          </Button>
        </div>
      );
    }
    return (
      <p className="px-4 py-2 text-sm text-muted-foreground">
        No lyrics found.
      </p>
    );
  }
  if (state.active.kind === "timed") {
    return <TimedLyrics lines={state.active.lines} />;
  }
  return <PlainLyrics text={state.active.text} />;
}

/** How long before a line's actual start time we flip it to active.
 *  At this moment the previous line's CSS transition begins fading it
 *  out and the new line's transition begins fading it in. The
 *  `duration-*` value on the line element controls how long that
 *  cross-fade takes — set a touch longer than the lookahead so the
 *  handoff feels smooth rather than crisp. */
const ACTIVE_LOOKAHEAD_S = 0.72;

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
 *  smaller pushes the active line up and reveals more upcoming text. */
const ACTIVE_LINE_VIEWPORT_RATIO = 0.36;

/** Duration of the auto-scroll that re-centers the active line.
 *  Native `scrollTo({ behavior: "smooth" })` is non-configurable in
 *  Chromium (~300 ms regardless of distance), which feels jumpy on
 *  long jumps — we drive the scroll ourselves with rAF instead. */
const SCROLL_DURATION_MS = 720;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Sampler for a CSS-style `cubic-bezier(x1, y1, x2, y2)`, so a scroll we
 *  drive from rAF can share a curve with the CSS transitions running
 *  beside it. Bisection on the x axis: 20 steps resolve the parameter far
 *  finer than a pixel of scroll, and the whole thing runs a few hundred
 *  times per seek, which is nothing. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const axis = (a: number, b: number, s: number) =>
    3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = t;
    for (let i = 0; i < 20; i++) {
      s = (lo + hi) / 2;
      if (axis(x1, x2, s) < t) lo = s;
      else hi = s;
    }
    return axis(y1, y2, s);
  };
}

/** Seek curve: hard start, long decelerating tail (the one iOS uses for
 *  sheet transitions). Keep in sync with the `[data-lyrics-seek]` rule in
 *  index.css so the scroll and the line highlight decelerate together. */
const easeOutSeek = cubicBezier(0.32, 0.72, 0, 1);

/** A position change bigger than this is a seek, not playback. The audio
 *  engine pushes the playhead a few times a second, so anything past a
 *  second means it was moved: the progress slider, a click on a line,
 *  media keys, the floating player. */
const SEEK_JUMP_S = 1.2;

/** Auto-scroll duration for a seek. Short enough that dragging the slider
 *  feels like the text is attached to the thumb, long enough to read as
 *  motion rather than a cut. Each new drag step interrupts the previous
 *  animation from wherever it got to, the same way a re-triggered CSS
 *  transition would. */
const SEEK_SCROLL_DURATION_MS = 350;

function TimedLyrics({ lines }: { lines: TimedLine[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const seekHoldRef = useRef<number | null>(null);
  const playbackPosition = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);
  // While the slider is being dragged the store's position still follows
  // the audio element, since the seek lands on release. Preview the drag
  // target so the text tracks the thumb the whole way.
  const scrub = useScrubStore((s) => s.scrub);
  const position = scrub ?? playbackPosition;

  const activeIdx = findActiveIdx(lines, position);
  const prevActiveRef = useRef(activeIdx);
  const prevPositionRef = useRef(position);

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
      useScrubStore.getState().scrub ?? usePlaybackStore.getState().position,
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
        : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO -
          el.clientHeight / 2;
    container.scrollTop = Math.max(0, elTopWithinContent - target);
  }, [lines]);

  // A layout effect, not a passive one: on a seek the container has to be
  // repositioned and the line cross-fade suppressed *before* the browser
  // paints the frame that already carries the new active line.
  useLayoutEffect(() => {
    const previous = prevPositionRef.current;
    prevPositionRef.current = position;
    // Dragging the slider is a continuous seek, so every step of it
    // counts however small: the thumb can crawl a line at a time.
    const isSeek =
      scrub !== null || Math.abs(position - previous) > SEEK_JUMP_S;

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
    // the top of the viewport instead of the usual ~36% position. For
    // any later line, the active-line-above-center rule applies.
    const target =
      activeIdx === 0
        ? 0
        : container.clientHeight * ACTIVE_LINE_VIEWPORT_RATIO -
          el.clientHeight / 2;
    const targetTop = Math.max(0, elTopWithinContent - target);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (isSeek) {
      // `data-lyrics-seek` shortens the per-line color/scale transition to
      // match the scroll (see index.css). Set from a layout effect, so it
      // is in place before the browser styles the frame that already
      // carries the new active line — the slow 1.26s cross-fade never gets
      // a chance to start. Held for the length of the scroll rather than
      // cleared next frame: a running transition keeps its original
      // timing, but the next drag step must find the attribute still on.
      container.dataset.lyricsSeek = "true";
      if (seekHoldRef.current !== null) clearTimeout(seekHoldRef.current);
      seekHoldRef.current = window.setTimeout(() => {
        seekHoldRef.current = null;
        delete container.dataset.lyricsSeek;
      }, SEEK_SCROLL_DURATION_MS);
    }

    const startTop = container.scrollTop;
    const delta = targetTop - startTop;
    if (Math.abs(delta) < 1) return;

    // Seeking gets the short decelerating curve; playback keeps the long
    // symmetric glide.
    const duration = isSeek ? SEEK_SCROLL_DURATION_MS : SCROLL_DURATION_MS;
    const ease = isSeek ? easeOutSeek : easeInOutCubic;
    const startTs = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / duration);
      container.scrollTop = startTop + delta * ease(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    // `position` is a dependency even though only `activeIdx` moves the
    // scroll: the seek check has to see every tick, otherwise a jump that
    // lands inside the current line would sit in the ref and snap the
    // *next*, perfectly ordinary line change.
  }, [activeIdx, position, scrub]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (seekHoldRef.current !== null) clearTimeout(seekHoldRef.current);
    };
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className={cn(
          // The right inset is the room the active line's `scale-[1.06]`
          // needs. Text wraps against the layout box, but the scale is a
          // paint-time transform anchored at `origin-left`, so the active
          // line paints 6% wider than the box it wrapped inside and the
          // tail of the top row fell outside the column (`overflow-y-auto`
          // clips the x axis too). Reserving the overhang here rather than
          // on the active line alone keeps every line wrapping at the same
          // width, so nothing reflows at the moment a line lights up.
          // Percentage, not a fixed inset: the player card is resizable.
          "lyrics-no-scrollbar flex h-full flex-col gap-1 overflow-y-auto pl-1 pr-[6%] pt-0 pb-16",
          // The top fade kicks in only after the karaoke has moved past
          // the first line — that way the first line stays crisp at the
          // top of the column while the song hasn't started or is on
          // line 0. The bottom fade is on throughout: the column runs
          // past the panel edge from the very first line, and without it
          // the last row is sliced through mid-glyph.
          activeIdx >= 1 ? "lyrics-mask" : "lyrics-mask-bottom",
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
              onClick={() => seek(line.start)}
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
                  : a === "error"
                    ? "bg-destructive"
                    : "bg-transparent";
          return (
            <DropdownMenuItem
              key={s}
              onSelect={() => setPref(s)}
              // Only a source that answered and had nothing is unselectable.
              // A failed one stays pickable: selecting it is how the user
              // asks for another attempt.
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
