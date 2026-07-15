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
import { estimateLeadInOffset } from "@/lib/lyrics/auto-align";
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

/** A nudge is only meaningful against the lyric record it was tuned
 *  on. `sig` pins it there: when a better record replaces the old one
 *  (matcher fixes, cache-key bumps), a stale nudge would silently
 *  shift the CORRECT timings; that exact thing happened with a -5.5s
 *  nudge dialed in against wrong lyrics. Legacy plain-number entries
 *  are ignored for the same reason. */
type OffsetEntry = { s: number; sig: string };

function loadOffsetMap(): Record<string, OffsetEntry | number> {
  try {
    const raw = localStorage.getItem(OFFSETS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, OffsetEntry | number>;
    }
  } catch {
    /* corrupted entry, start fresh */
  }
  return {};
}

function loadOffset(videoId: string, recordSig: string | null): number {
  const v = loadOffsetMap()[videoId];
  if (
    v &&
    typeof v === "object" &&
    Number.isFinite(v.s) &&
    recordSig !== null &&
    v.sig === recordSig
  ) {
    return v.s;
  }
  return 0;
}

function saveOffset(
  videoId: string,
  seconds: number,
  recordSig: string | null,
): void {
  try {
    const map = loadOffsetMap();
    // Delete-then-set moves the key to the end of insertion order, so
    // the cap below always evicts the least recently adjusted tracks.
    delete map[videoId];
    if (seconds !== 0 && recordSig !== null) {
      map[videoId] = { s: seconds, sig: recordSig };
    }
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
  const autoOffsetRef = useRef(0);
  // The active record's signature lands after the queries resolve;
  // mirrored in a ref so the user-triggered nudge handlers always see
  // the current one.
  const recordSigRef = useRef<string | null>(null);
  const [offset, setOffsetState] = useState(0);
  const nudgeOffset = (deltaSeconds: number) => {
    if (!videoId) return;
    // Round to the step grid so repeated float adds can't drift into
    // 0.7500000000000001-style labels. Seed from the auto-alignment
    // when the user hasn't nudged yet, so the first click fine-tunes
    // it instead of snapping back to zero.
    const base = offset !== 0 ? offset : autoOffsetRef.current;
    const raw = base + deltaSeconds;
    const next = Math.max(
      -OFFSET_LIMIT_S,
      Math.min(
        OFFSET_LIMIT_S,
        Math.round(raw / OFFSET_STEP_S) * OFFSET_STEP_S,
      ),
    );
    setOffsetState(next);
    saveOffset(videoId, next, recordSigRef.current);
  };
  const resetOffset = () => {
    if (!videoId) return;
    setOffsetState(0);
    saveOffset(videoId, 0, recordSigRef.current);
    setAutoOffset(0);
  };

  const { queries, best, isLoading } = useLyricsSources(track, !!track);

  // Auto-alignment for uploads with a padded intro: when the playing
  // file is a few seconds longer than the recording the timings were
  // cut for AND the audio itself starts that many seconds in, shift
  // the lyrics by that lead-in. Applies only while the user hasn't set
  // their own nudge; a manual nudge always wins.
  const streamUrl = usePlaybackStore((s) => s.streamUrl);
  const realDuration = usePlaybackStore((s) => s.duration);
  const [autoOffset, setAutoOffset] = useState(0);
  // Mirrored in a ref so nudgeOffset (declared above) can seed from the
  // current auto value without stale-closure games.
  autoOffsetRef.current = autoOffset;
  useEffect(() => {
    setAutoOffset(0);
  }, [videoId]);

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

  const recordDurationSec =
    active?.kind === "timed" ? active.recordDurationSec : undefined;
  const recordSig =
    active?.kind === "timed"
      ? `${active.source ?? ""}:${recordDurationSec ?? 0}`
      : null;
  recordSigRef.current = recordSig;
  // Load the saved nudge only once the record it was tuned against is
  // known, so a nudge pinned to a different record stays ignored.
  useEffect(() => {
    setOffsetState(videoId ? loadOffset(videoId, recordSig) : 0);
  }, [videoId, recordSig]);

  useEffect(() => {
    if (!videoId || offset !== 0) return;
    if (!streamUrl || !realDuration || !recordDurationSec) return;
    let cancelled = false;
    void estimateLeadInOffset(streamUrl, realDuration, recordDurationSec).then(
      (o) => {
        if (!cancelled && o) setAutoOffset(o);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [videoId, streamUrl, realDuration, recordDurationSec, offset]);

  // The user's saved nudge wins outright; the estimated lead-in only
  // fills the gap while they haven't touched the dial.
  const effectiveOffset = offset !== 0 ? offset : autoOffset;

  return {
    active,
    isLoading,
    hasTrack: !!track,
    pref,
    setPref,
    best,
    availability,
    offset: effectiveOffset,
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

/** Empty timed lines shorter than this render as whitespace between
 *  stanzas; longer ones are real instrumental breaks and show ♪. */
const BREAK_NOTE_MIN_S = 8;

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

  // A short break marker (invisible spacer) can become the "active"
  // line between stanzas, which made the highlight vanish for a few
  // seconds. Hold the previous sung line instead; real instrumental
  // breaks (>= BREAK_NOTE_MIN_S, rendered as a visible note) still
  // take the highlight themselves.
  const isSpacerLine = (l: TimedLine) =>
    !l.text && (l.end ?? Infinity) - l.start < BREAK_NOTE_MIN_S;

  // Positive offset = lyrics fire later, i.e. the playhead is treated
  // as being earlier in the song. Kept in a ref too so the mount-snap
  // effect below (deps: [lines]) reads the current value without
  // re-snapping on every nudge.
  const rawActiveIdx = findActiveIdx(lines, position - offset);
  let activeIdx = rawActiveIdx;
  while (activeIdx > 0 && isSpacerLine(lines[activeIdx])) activeIdx--;
  // Before the first line's time the column showed every line dim with
  // nothing highlighted — a dead pane at track start. Cue the first
  // line as active during the intro, the way Apple Music points at
  // what's coming.
  if (activeIdx < 0 && lines.length > 0) activeIdx = 0;
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
          "lyrics-no-scrollbar group flex h-full flex-col gap-0 overflow-y-auto px-1 pt-0 pb-16",
          // Full mask kicks in only after the karaoke has moved past
          // the first line — that way the first line stays crisp at
          // the top of the column while the song hasn't started or is
          // on line 0. The bottom melt is always on so upcoming lines
          // never cut off hard against the pane edge.
          activeIdx >= 1 ? "lyrics-mask" : "lyrics-mask-bottom",
        )}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          // Distance ahead of the karaoke, for the visibility falloff.
          // Before the song starts (activeIdx -1) the first lines get
          // the same gentle ramp instead of all rendering dim.
          const ahead = i - activeIdx;
          // Continuous falloff, not a cliff: each upcoming line keeps a
          // little less presence than the previous, all the way down,
          // so the column melts into the pane's bottom mask the way
          // Apple Music's does. A hard cutoff after a few lines left a
          // blank hole between the last readable line and the pane
          // edge. Fed through a CSS var so the group-hover reveal
          // (a class) can still win over it.
          const fall = isActive
            ? 1
            : isPast
              ? 0.35
              : Math.max(0.1, 0.8 - 0.115 * ahead);
          // Empty timed lines are the LRC's stanza/interlude markers.
          // Short ones render as pure whitespace so consecutive sung
          // lines read as verse blocks (the Apple Music grouping);
          // only a window long enough to be a real instrumental break
          // earns the ♪ placeholder. The spacer keeps data-line-idx so
          // the auto-scroll can still target it when it goes active.
          if (!line.text) {
            const windowS = (line.end ?? Infinity) - line.start;
            if (windowS < BREAK_NOTE_MIN_S) {
              return (
                <div
                  key={i}
                  data-line-idx={i}
                  aria-hidden
                  className="h-7 shrink-0"
                />
              );
            }
          }
          return (
            <button
              key={i}
              type="button"
              data-line-idx={i}
              onClick={() => seek(line.start + offset)}
              style={{ "--line-o": String(fall) } as React.CSSProperties}
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
                // Apple-Music treatment: the active line is crisp and
                // bright; every other line is dimmed AND softly blurred,
                // past lines slightly more so. Blur eases with the same
                // clock as the color so lines melt in/out while the
                // column scrolls. Hovering the column sharpens all lines
                // (via group-hover below) so scanning ahead stays easy.
                // Apple Music shows a WINDOW, not the whole sheet: past
                // lines vanish, the active line is crisp, and only the
                // next few lines are visible with a steep falloff.
                // Hovering the column (group-hover, fast duration)
                // brings everything back for scanning/seeking.
                // NOTE: `filter` is deliberately NOT in the transition
                // list. Animating blur forces WebKit to re-rasterize
                // every line's layer each frame, which starves the
                // rAF scroll (the column visibly stutter-jumped on
                // every line change). Snapped blur under motion is
                // imperceptible; scroll stays pure compositing.
                "lyrics-line origin-left cursor-pointer rounded-md px-2 py-1 text-left text-lg font-[650] leading-snug opacity-(--line-o) transition-[scale,color,opacity] duration-[1260ms] ease-in-out hover:bg-black/30 hover:blur-none group-hover:duration-200",
                isActive
                  ? "scale-[1.04] text-foreground blur-none"
                  : isPast
                    ? "scale-100 text-muted-foreground/45 blur-[2px]"
                    : ahead === 1
                      ? "scale-100 text-muted-foreground/60 blur-[1px]"
                      : ahead === 2
                        ? "scale-100 text-muted-foreground/55 blur-[1.5px]"
                        : "scale-100 text-muted-foreground/50 blur-[2px]",
                !isActive && "group-hover:opacity-80 group-hover:blur-none",
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
    <div className="lyrics-plain lyrics-mask app-scroll h-full overflow-y-auto whitespace-pre-wrap px-2 pt-0 pb-12 text-lg font-medium leading-relaxed text-foreground/90">
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
