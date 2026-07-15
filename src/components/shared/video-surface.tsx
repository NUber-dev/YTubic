import { useLayoutEffect, useRef } from "react";
import { getMediaElement } from "@/lib/audio-engine";
import { cn } from "@/lib/utils";

/**
 * Adopts the audio engine's singleton <video> element as a visible
 * surface. The element lives detached for audio-only streams and keeps
 * playing while unmounted; mounting it here only makes its frames
 * visible, playback ownership stays with the engine.
 *
 * Reparent-safe: two surfaces can overlap across a mount boundary (the
 * fullscreen stage opening over the side panel). Adoption is a plain
 * appendChild, which MOVES the element without re-running media
 * selection, so position and playback survive. Cleanup only detaches
 * when this host still owns the element, so an older surface unmounting
 * can't yank it out of the newer one. Sizing lives on the host via a
 * child selector, never on el.className, for the same ownership reason.
 * useLayoutEffect keeps the detach→attach handoff inside one paint.
 */
export function VideoSurface({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = getMediaElement();
    if (!host || !el) return;
    host.appendChild(el);
    return () => {
      if (el.parentElement === host) el.remove();
    };
  }, []);
  return (
    <div
      ref={hostRef}
      className={cn(
        "[&>video]:block [&>video]:size-full [&>video]:object-contain",
        className,
      )}
    />
  );
}
