import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useLayoutStore } from "@/lib/store/layout";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  tracks: ShelfItem[];
};

/**
 * Floating pill anchored to the bottom of the content area that scrolls
 * the track list to whichever row matches the currently-playing track.
 * Hidden when nothing is playing, when the active track isn't in this
 * list, or when the active row is already visible in the scroll
 * viewport. Arrow flips up/down based on whether the active row is
 * above or below the visible window.
 *
 * Rendered through a portal into `document.body`. The natural mount
 * point is inside `<main className="overflow-y-auto">` and the
 * `relative z-10` content wrapper, and Chromium reads `backdrop-filter`
 * snapshots within the nearest backdrop-rooting ancestor — `overflow`
 * scrollers and stacking-context ancestors both qualify, so the pill's
 * captured backdrop came back empty even though the element was
 * `position: fixed`. Mounting at the body level escapes both.
 */
export function JumpToCurrentButton({ tracks }: Props) {
  const active = usePlaybackStore(currentTrack);
  const { state } = useSidebar();
  const mode = useLayoutStore((s) => s.mode);
  const [activeOnScreen, setActiveOnScreen] = useState(false);
  const [activeAbove, setActiveAbove] = useState(false);

  const activeVideoId = active?.videoId;
  const inList = activeVideoId
    ? tracks.some((t) => t.id === activeVideoId)
    : false;

  // Watch the active row's position vs. the scroll viewport. Need this
  // for two things: hiding the pill when the row is already on screen,
  // and choosing which arrow direction to render. We use a scroll
  // listener (rather than IntersectionObserver) because we also need to
  // know which side the row is off — IO only tells us "intersecting yes
  // or no", not "above or below".
  useEffect(() => {
    setActiveOnScreen(false);
    setActiveAbove(false);
    if (!activeVideoId || !inList) return;
    const el = document.querySelector<HTMLElement>(
      `[data-videoid="${CSS.escape(activeVideoId)}"]`,
    );
    if (!el) return;
    const scroller = el.closest<HTMLElement>(".app-scroll");
    if (!scroller) return;

    const update = () => {
      const elRect = el.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const visible =
        elRect.bottom > scrollerRect.top && elRect.top < scrollerRect.bottom;
      setActiveOnScreen(visible);
      if (!visible) {
        setActiveAbove(elRect.bottom <= scrollerRect.top);
      }
    };

    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", update);
    };
  }, [activeVideoId, inList]);

  if (!active || !inList || activeOnScreen) return null;

  // Match the sidebar's own width values from SidebarProvider (app-shell)
  // so the pill stays horizontally centered in the visible content area.
  // The right edge moves with the player layout: tucked next to the
  // 22rem side card in `right` mode, hugging the window edge in
  // `bottom`/`floating` modes. The bottom offset lifts above the
  // bottom-bar when it's present.
  const left = state === "collapsed" ? "4rem" : "13rem";
  const right = mode === "right" ? "23rem" : "1rem";
  const bottom = mode === "bottom" ? "6rem" : "1rem";
  const Icon = activeAbove ? ArrowUpIcon : ArrowDownIcon;

  return createPortal(
    <Button
      size="sm"
      className="fixed z-20 mx-auto w-fit rounded-full border border-sidebar-border text-sidebar-foreground shadow-lg transition-[left,right,bottom] duration-150 ease-linear"
      style={{
        left,
        right,
        bottom,
        backgroundColor: "var(--surface)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={() => {
        const el = document.querySelector<HTMLElement>(
          `[data-videoid="${CSS.escape(active.videoId)}"]`,
        );
        if (!el) return;
        // Scroll only the immediate `.app-scroll` container — using
        // Element.scrollIntoView would also scroll any overflow-hidden
        // ancestor (overflow:hidden blocks visual overflow, not
        // programmatic scrolling), which knocks the custom title bar
        // off-screen with no way to scroll it back via the UI.
        const scroller = el.closest<HTMLElement>(".app-scroll");
        if (!scroller) return;
        const elRect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const target =
          scroller.scrollTop +
          (elRect.top - scrollerRect.top) -
          (scrollerRect.height - elRect.height) / 2;
        scroller.scrollTo({ top: target, behavior: "smooth" });
      }}
    >
      Currently Playing
      <Icon />
    </Button>,
    document.body,
  );
}
