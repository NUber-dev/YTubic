import { usePlayerDragStore } from "@/lib/player-drag";

/** How far the cursor has to be from an edge for the glow to start
 *  appearing. Beyond this distance the strip is fully invisible. */
const PROXIMITY_RANGE_PX = 240;

/** Base width/height of an edge strip when the cursor is JUST inside
 *  the proximity range. The strip grows another `+_BOOST_PX` as the
 *  cursor approaches the edge — gives the "magnetic pull" feel. */
const STRIP_BASE_PX = 100;
const STRIP_BOOST_PX = 200;

/**
 * Visualization for the in-flight cover drag. Two soft red gradients
 * along the right and bottom edges, one per snap zone — each fades
 * from the brand red right at the edge to fully transparent further
 * inside the window. Both their opacity AND their thickness scale
 * with how close the cursor is to that edge, so the glow visibly
 * "ramps up" as the user approaches the snap point. When the cursor
 * lands inside a snap zone the gradient locks at full intensity.
 *
 * If the cursor leaves the window entirely (`zone === "out"`) the
 * edge strips fade out and an inset perimeter glow takes over to
 * say "release here to spawn a floating window."
 *
 * Everything is `pointer-events-none` so the live drag's pointermove
 * / pointerup events keep flowing through to the captured target.
 */
export function DragSnapOverlay() {
  const active = usePlayerDragStore((s) => s.active);
  const zone = usePlayerDragStore((s) => s.zone);
  const cursor = usePlayerDragStore((s) => s.cursor);

  if (!active) return null;

  const w = typeof window !== "undefined" ? window.innerWidth : 0;
  const h = typeof window !== "undefined" ? window.innerHeight : 0;

  // Distance to each edge in CSS pixels (clamped to >=0 so cursors
  // outside the viewport read as "at the edge"). Maps to a 0..1
  // proximity factor where 1 = touching.
  const distRight = cursor ? Math.max(0, w - cursor.x) : Infinity;
  const distBottom = cursor ? Math.max(0, h - cursor.y) : Infinity;
  const rightProx = clamp01(1 - distRight / PROXIMITY_RANGE_PX);
  const bottomProx = clamp01(1 - distBottom / PROXIMITY_RANGE_PX);

  // While the cursor is outside the window, both edge strips dim and
  // the perimeter glow takes over — keeps the visual story singular
  // ("you're about to drop here") rather than competing.
  //
  // Opacity numbers are deliberately quiet — the strips are a *hint*
  // that drop zones exist, not a dominant overlay competing with the
  // page content underneath.
  const rightOpacity =
    zone === "out"
      ? 0
      : zone === "right"
        ? 0.5
        : rightProx * 0.25;
  const rightWidth = STRIP_BASE_PX + rightProx * STRIP_BOOST_PX;

  const bottomOpacity =
    zone === "out"
      ? 0
      : zone === "bottom"
        ? 0.5
        : bottomProx * 0.25;
  const bottomHeight = STRIP_BASE_PX + bottomProx * STRIP_BOOST_PX;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50"
      style={{ contain: "layout paint" }}
    >
      {/* Right-edge red gradient strip. Stops are deliberately soft —
          even at the very edge the color is partially transparent
          (~60%) so the strip never overpowers content underneath; it
          just hints at the snap target. */}
      <div
        className="absolute right-0 top-0 h-full transition-[opacity,width] duration-150 ease-out"
        style={{
          width: `${rightWidth}px`,
          opacity: rightOpacity,
          background:
            "linear-gradient(to left, color-mix(in srgb, var(--brand) 60%, transparent) 0%, color-mix(in srgb, var(--brand) 12%, transparent) 30%, transparent 100%)",
        }}
      />

      {/* Bottom-edge gradient — same recipe rotated 90°. */}
      <div
        className="absolute bottom-0 left-0 w-full transition-[opacity,height] duration-150 ease-out"
        style={{
          height: `${bottomHeight}px`,
          opacity: bottomOpacity,
          background:
            "linear-gradient(to top, color-mix(in srgb, var(--brand) 60%, transparent) 0%, color-mix(in srgb, var(--brand) 12%, transparent) 30%, transparent 100%)",
        }}
      />

      {/* Pull-out indicator — shows up when the cursor leaves the
          window. An inset shadow makes all four edges glow at once,
          telling the user "release here for a floating window." */}
      <div
        className="absolute inset-0 transition-opacity duration-150 ease-out"
        style={{
          opacity: zone === "out" ? 1 : 0,
          boxShadow:
            "inset 0 0 80px 16px color-mix(in srgb, var(--brand) 22%, transparent)",
        }}
      />
    </div>
  );
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
