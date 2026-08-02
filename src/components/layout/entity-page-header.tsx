import { memo, useEffect, useRef } from "react";
import { PlayIcon, ShuffleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { Thumbnail } from "@/components/shared/thumbnail";
import { cn } from "@/lib/utils";
import {
  useEntityHeaderStore,
  type EntityHeaderConfig,
} from "@/lib/store/entity-header";

const EXPANDED_HEIGHT = 184;
const COMPACT_HEIGHT = 66;
const COLLAPSE_DISTANCE = EXPANDED_HEIGHT - COMPACT_HEIGHT;
const TOOLBAR_HEIGHT = 60;
const COVER_SIZE = 148;
const COMPACT_COVER_SIZE = 44;
const COMPACT_ROUND_COVER_SIZE = 48;
const COVER_TOP = 18;
// Visual (post-scale) corner radius of the square cover. The single cover
// element shrinks by transform, which would shrink its radius along with it,
// so `apply()` divides these by the current scale to keep them literal.
const COVER_RADIUS = 12;
const COMPACT_COVER_RADIUS = 8;
const COMPACT_COVER_TOP = 11;
const COMPACT_ROUND_COVER_TOP = 9;
const INFO_LEFT = 206;
const COMPACT_INFO_LEFT = 82;
const COMPACT_ROUND_INFO_LEFT = 86;

/**
 * One physical header that morphs using compositor-only transforms.
 * The scroller permanently reserves the expanded height, so every pixel of
 * wheel movement remains one pixel of content movement. No layout property is
 * changed while scrolling and no geometry is read from the hot scroll path.
 */
export function EntityPageHeader() {
  const config = useEntityHeaderStore((s) => s.config);
  const hasConfig = config !== null;
  const hasToolbar = config?.toolbar != null;
  const keepSubtitleInCompact = config?.keepSubtitleInCompact === true;
  const useLargeCompactAvatar = config?.round === true;
  const setHeaderHeight = useEntityHeaderStore((s) => s.setHeaderHeight);
  const headerRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const coverOutlineRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef({
    titleTop: 0,
    actionsTop: 0,
    actionsX: 0,
  });

  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("main.app-scroll");
    const scrollContent = scroller?.querySelector<HTMLElement>(
      ":scope > .app-scroll-content",
    );
    const header = headerRef.current;
    const cover = coverRef.current;
    const title = titleRef.current;
    const details = detailsRef.current;
    if (
      !scroller ||
      !scrollContent ||
      !header ||
      !cover ||
      !title ||
      !details ||
      !hasConfig
    )
      return;

    const toolbarHeight = hasToolbar ? TOOLBAR_HEIGHT : 0;
    const expandedTotalHeight = EXPANDED_HEIGHT + toolbarHeight;
    const compactTotalHeight = COMPACT_HEIGHT + toolbarHeight;
    setHeaderHeight(expandedTotalHeight);
    let frame = 0;

    // Geometry is measured only when content or the window size changes.
    // The resulting deltas are cached and reused throughout scrolling.
    const measure = () => {
      const actions = actionsRef.current;
      geometryRef.current = {
        titleTop: title.offsetTop,
        actionsTop: actions?.offsetTop ?? 0,
        actionsX: actions
          ? header.clientWidth - 24 - actions.offsetWidth - INFO_LEFT
          : 0,
      };
    };

    const apply = () => {
      frame = 0;
      const top = Math.max(0, scroller.scrollTop);
      const progress = Math.min(1, top / COLLAPSE_DISTANCE);
      const { titleTop, actionsTop, actionsX } = geometryRef.current;
      const compactCoverSize = useLargeCompactAvatar
        ? COMPACT_ROUND_COVER_SIZE
        : COMPACT_COVER_SIZE;
      const compactCoverTop = useLargeCompactAvatar
        ? COMPACT_ROUND_COVER_TOP
        : COMPACT_COVER_TOP;
      const compactInfoLeft = useLargeCompactAvatar
        ? COMPACT_ROUND_INFO_LEFT
        : COMPACT_INFO_LEFT;
      const coverScale = 1 - progress * (1 - compactCoverSize / COVER_SIZE);
      const titleScale = 1 - progress * 0.45;
      // Keep subtitle/metadata visually attached to the moving title.
      // They remain fully readable through the first part of the morph,
      // then fade only as the compact bar runs out of vertical room.
      const detailFade = keepSubtitleInCompact
        ? 0
        : Math.min(1, Math.max(0, (progress - 0.35) / 0.25));
      const detailOpacity = 1 - detailFade;
      const infoX = (compactInfoLeft - INFO_LEFT) * progress;
      const compactTitleTop = keepSubtitleInCompact ? 8 : 20;
      const infoY = (compactTitleTop - titleTop) * progress;
      // Follow the title's visual bottom edge, including the height it
      // loses while scaling. Without this compensation the subtitle's
      // gap grows and makes it look as if it drifts downward.
      const detailsY = keepSubtitleInCompact
        ? (32 - (titleTop + 46)) * progress
        : infoY + 46 * (titleScale - 1) - 8 * progress;

      cover.style.transform = `translate3d(0, ${(compactCoverTop - COVER_TOP) * progress}px, 0) scale(${coverScale})`;
      if (!useLargeCompactAvatar) {
        const radius =
          COVER_RADIUS + (COMPACT_COVER_RADIUS - COVER_RADIUS) * progress;
        cover.style.borderRadius = `${radius / coverScale}px`;
      }
      // Same compensation for the outline: a plain 1px border would be
      // scaled down to a third of a pixel by the time the header is fully
      // collapsed, leaving the compact cover with no visible edge.
      const coverOutline = coverOutlineRef.current;
      if (coverOutline) {
        coverOutline.style.borderWidth = `${1 / coverScale}px`;
      }
      title.style.transform = `translate3d(${infoX}px, ${infoY}px, 0) scale(${titleScale})`;
      details.style.opacity = String(detailOpacity);
      details.style.visibility = detailOpacity <= 0 ? "hidden" : "visible";
      details.style.transform = `translate3d(${infoX}px, ${detailsY}px, 0)`;

      const actions = actionsRef.current;
      if (actions) {
        actions.style.transform = `translate3d(${actionsX * progress}px, ${(13 - actionsTop) * progress}px, 0)`;
      }

      const toolbar = toolbarRef.current;
      if (toolbar) {
        toolbar.style.transform = `translate3d(0, ${-Math.min(top, COLLAPSE_DISTANCE)}px, 0)`;
      }

      const clipHeight = Math.max(
        compactTotalHeight,
        expandedTotalHeight - top,
      );
      // Clip only the route content. Applying this to the scroller itself
      // would also cut its native scrollbar under the header.
      scrollContent.style.clipPath = `inset(${top + clipHeight}px 0 0 0)`;
    };

    const scheduleApply = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    measure();
    apply();
    const resizeObserver = new ResizeObserver(() => {
      measure();
      scheduleApply();
    });
    resizeObserver.observe(header);
    if (actionsRef.current) resizeObserver.observe(actionsRef.current);
    scroller.addEventListener("scroll", scheduleApply, { passive: true });

    return () => {
      scroller.removeEventListener("scroll", scheduleApply);
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      scrollContent.style.clipPath = "";
    };
    // Playlist pages publish fresh callback/action identities whenever a
    // continuation lands. The scroll driver depends only on the header being
    // mounted, not on those identities, so keep it alive across config updates.
  }, [
    hasConfig,
    hasToolbar,
    keepSubtitleInCompact,
    setHeaderHeight,
    useLargeCompactAvatar,
  ]);

  if (!config) return null;

  const hasActions = !!(config.onPlay || config.onShuffle || config.actions);
  const detailsHeight =
    (config.subtitle ? 24 : 0) +
    (config.metadata ? 22 : 0) +
    (hasActions ? 58 : 0);
  const titleTop = Math.max(18, (EXPANDED_HEIGHT - 46 - detailsHeight) / 2);

  return (
    <div
      ref={headerRef}
      className="pointer-events-none absolute inset-x-0 top-0 z-20"
      style={{
        height: EXPANDED_HEIGHT + (hasToolbar ? TOOLBAR_HEIGHT : 0),
      }}
    >
      <div
        ref={coverRef}
        className="pointer-events-auto absolute left-6 top-[18px] size-[148px] origin-top-left"
        style={{
          willChange: "transform",
          borderRadius: config.round ? undefined : COVER_RADIUS,
        }}
      >
        <Thumbnail
          thumbnails={config.thumbnails}
          alt={config.title}
          round={config.round}
          className={cn(
            "size-full",
            !config.round && "rounded-[inherit] shadow-lg",
          )}
          targetSize={512}
          highRes
        />
        <ArtworkOutline
          ref={coverOutlineRef}
          className={config.round ? "rounded-full" : "rounded-[inherit]"}
        />
      </div>

      <h1
        ref={titleRef}
        className="pointer-events-auto absolute right-6 min-w-0 origin-top-left truncate text-[40px] font-bold leading-[1.15] tracking-tight"
        style={{ left: INFO_LEFT, top: titleTop, willChange: "transform" }}
      >
        {config.title}
      </h1>

      <div
        ref={detailsRef}
        className="pointer-events-auto absolute right-6"
        style={{
          left: INFO_LEFT,
          top: titleTop + 46,
          willChange: "opacity, transform",
        }}
      >
        {config.subtitle ? (
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {config.subtitle}
          </p>
        ) : null}
        {config.metadata ? (
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {config.metadata}
          </p>
        ) : null}
      </div>

      {hasActions ? (
        <div
          ref={actionsRef}
          className="pointer-events-auto absolute flex shrink-0 items-center gap-2"
          style={{
            left: INFO_LEFT,
            top:
              titleTop +
              46 +
              (config.subtitle ? 24 : 0) +
              (config.metadata ? 22 : 0) +
              18,
            willChange: "transform",
          }}
        >
          <HeaderActions config={config} />
        </div>
      ) : null}

      {config.toolbar ? (
        <div
          ref={toolbarRef}
          className="pointer-events-auto absolute inset-x-6 top-[184px] h-[60px] pt-[11px]"
          style={{ willChange: "transform" }}
        >
          {config.toolbar}
        </div>
      ) : null}
    </div>
  );
}

const HeaderActions = memo(function HeaderActions({
  config,
}: {
  config: EntityHeaderConfig;
}) {
  return (
    <>
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
    </>
  );
});
