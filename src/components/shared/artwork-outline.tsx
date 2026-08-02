import type { Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Adaptive hairline drawn on top of artwork — covers, tinted mood cards,
 * the explore tiles.
 *
 * A flat `border-hairline` is a fixed white wash, so over a saturated cover
 * it reads as a grey line sitting on the image. Inverting what is underneath
 * instead keeps the edge in the artwork's own colour: it darkens against a
 * light corner and lightens against a dark one.
 *
 * The radius (and any transform compensation) belongs to whatever is being
 * outlined, so it comes in through `className`.
 *
 * Give the wrapper `isolate` (or another stacking context) unless it already
 * has one. Blending forces the nearest stacking-context ancestor to become an
 * isolated group, and an isolated group is also a backdrop root — so without
 * it, an unrelated `backdrop-filter` further up the same subtree silently
 * loses everything behind that ancestor and paints as a flat dark block.
 */
export function ArtworkOutline({
  className,
  ref,
}: {
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 border border-white opacity-15 mix-blend-difference",
        className,
      )}
    />
  );
}
