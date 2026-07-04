import { memo, useEffect, useRef, useState } from "react";
import { PlayIcon, ShuffleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/shared/thumbnail";
import { cn } from "@/lib/utils";
import {
  useEntityHeaderStore,
  type EntityHeaderConfig,
} from "@/lib/store/entity-header";

/**
 * Two-state morphing route header (hero ↔ compact bar).
 *
 * Architecture: lives **outside** `<main>` in flex flow so track rows
 * inside `<main>` are clipped by `<main>`'s `overflow-hidden` and can
 * never appear under the bar — that's how we get the "no own
 * background, but tracks aren't visible behind it" effect without
 * adding a backdrop blur.
 *
 * Performance: every animated property is either `opacity` or
 * `transform` (both composited off the main thread on a dedicated GPU
 * layer). `will-change` + `translate3d` force layer promotion so the
 * compositor doesn't have to create a new layer at the moment the
 * transition begins.
 *
 * The container height is the one non-GPU property — it has to
 * shrink so the page below moves up. Optimisations to keep that
 * cheap:
 *   • `contain: paint` isolates the paint subtree.
 *   • `HeroLayout` and `CompactLayout` are `React.memo`'d so a parent
 *     re-render on `compact` toggle doesn't rebuild their subtrees.
 *   • The scroll listener is rAF-throttled so we hit `setState` at
 *     most once per frame even when the browser fires 120 Hz scroll
 *     events.
 *
 * Specifically NOT used: Motion's `layout` / `layoutId`. FLIP measures
 * old + new bounding boxes every render and tweens `transform: scale`
 * between them. That was the source of (a) the buttons stretching
 * (different `default` vs `sm` widths produced `scaleX ≠ 1`), and
 * (b) the 10 fps lag from doing FLIP on five+ elements at once.
 */

/** Hysteresis thresholds. Narrow but non-zero so a sub-pixel jitter
 *  at the very top doesn't flicker the bar. */
const COMPACT_AT = 16;
const LARGE_AT = 4;

/** Fixed pixel height of the compact bar. */
const COMPACT_HEIGHT = 72;

/** Animation timing — kept tight so the cross-fade reads as a snap
 *  rather than a leisurely tween (user feedback: previous 240 ms felt
 *  draggy). */
const TRANSITION_MS = 200;
const EASE = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";

export function EntityPageHeader() {
  const config = useEntityHeaderStore((s) => s.config);
  const [compact, setCompact] = useState(false);
  const heroRef = useRef<HTMLDivElement>(null);
  const [heroHeight, setHeroHeight] = useState(0);

  // rAF-throttled scroll listener: we only need to update `compact`
  // once per frame at most. Without this the listener fires on every
  // wheel/touch event (120 Hz on high-refresh displays), which is
  // wasted work even though setState bails out on equal values.
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("main.app-scroll");
    if (!scroller) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const top = scroller.scrollTop;
      setCompact((prev) => {
        if (prev && top <= LARGE_AT) return false;
        if (!prev && top >= COMPACT_AT) return true;
        return prev;
      });
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(tick);
    };
    tick();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Track the hero's natural height so the container's height tween
  // has a real target. `ResizeObserver` re-measures when content
  // changes (longer description after a slow fetch, title wrapping
  // to two lines) without forcing a remount.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const measure = () => setHeroHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [config]);

  if (!config) return null;

  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{
        // Height SNAPS instantly between hero and compact — no
        // `transition: height`. Animating height resized `<main>` on
        // every frame, and `@tanstack/react-virtual` recomputed
        // visible rows on each ResizeObserver tick → main-thread
        // jank. Snapping = virtualizer recomputes once. The opacity
        // cross-fade below masks the layout snap visually.
        height: compact ? COMPACT_HEIGHT : heroHeight || "auto",
        contain: "paint",
      }}
    >
      <div
        ref={heroRef}
        aria-hidden={compact}
        style={{
          opacity: compact ? 0 : 1,
          transform: compact
            ? "translate3d(0, -6px, 0)"
            : "translate3d(0, 0, 0)",
          transition: `opacity ${TRANSITION_MS}ms ${EASE}, transform ${TRANSITION_MS}ms ${EASE}`,
          pointerEvents: compact ? "none" : "auto",
          willChange: "opacity, transform",
          backfaceVisibility: "hidden",
        }}
      >
        <HeroLayout config={config} />
      </div>
      <div
        aria-hidden={!compact}
        className="absolute inset-x-0 top-0"
        style={{
          height: COMPACT_HEIGHT,
          opacity: compact ? 1 : 0,
          transform: compact
            ? "translate3d(0, 0, 0)"
            : "translate3d(0, -6px, 0)",
          transition: `opacity ${TRANSITION_MS}ms ${EASE}, transform ${TRANSITION_MS}ms ${EASE}`,
          pointerEvents: compact ? "auto" : "none",
          willChange: "opacity, transform",
          backfaceVisibility: "hidden",
        }}
      >
        <CompactLayout config={config} />
      </div>
    </div>
  );
}

const HeroLayout = memo(function HeroLayout({
  config,
}: {
  config: EntityHeaderConfig;
}) {
  const hasButtons = !!(config.onPlay || config.onShuffle || config.actions);
  return (
    <div className="flex flex-row items-end gap-6 px-6 pt-3 pb-4">
      <Thumbnail
        thumbnails={config.thumbnails}
        alt={config.title}
        round={config.round}
        className={cn(
          "size-40 shrink-0",
          config.round ? "" : "border border-hairline shadow-lg",
        )}
        targetSize={512}
        highRes
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h1 className="truncate text-3xl font-bold leading-tight tracking-tight md:text-4xl">
          {config.title}
        </h1>
        {config.subtitle ? (
          <p className="truncate text-sm text-muted-foreground">
            {config.subtitle}
          </p>
        ) : null}
        {config.metadata ? (
          <p className="truncate text-xs text-muted-foreground">
            {config.metadata}
          </p>
        ) : null}
        {config.description ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">
            {config.description}
          </p>
        ) : null}
        {hasButtons ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {config.onPlay ? (
              <Button
                onClick={config.onPlay}
                className="bg-brand text-white hover:bg-brand/90"
              >
                <PlayIcon className="fill-current" />
                Play
              </Button>
            ) : null}
            {config.onShuffle ? (
              <Button variant="outline" onClick={config.onShuffle}>
                <ShuffleIcon />
                Shuffle
              </Button>
            ) : null}
            {config.actions}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const CompactLayout = memo(function CompactLayout({
  config,
}: {
  config: EntityHeaderConfig;
}) {
  const hasButtons = !!(config.onPlay || config.onShuffle || config.actions);
  return (
    <div className="flex h-full flex-row items-center gap-3 px-6">
      <Thumbnail
        thumbnails={config.thumbnails}
        alt={config.title}
        round={config.round}
        className={cn(
          "size-14 shrink-0",
          config.round ? "" : "border border-hairline shadow",
        )}
        targetSize={256}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-base font-semibold leading-tight">
          {config.title}
        </h2>
        {config.metadata ? (
          <p className="truncate text-xs text-muted-foreground">
            {config.metadata}
          </p>
        ) : null}
      </div>
      {hasButtons ? (
        <div className="flex shrink-0 items-center gap-2">
          {config.onPlay ? (
            <Button
              onClick={config.onPlay}
              size="sm"
              className="bg-brand text-white hover:bg-brand/90"
            >
              <PlayIcon className="fill-current" />
              Play
            </Button>
          ) : null}
          {config.onShuffle ? (
            <Button variant="outline" size="sm" onClick={config.onShuffle}>
              <ShuffleIcon />
              Shuffle
            </Button>
          ) : null}
          {config.actions}
        </div>
      ) : null}
    </div>
  );
});
