import type { ComponentProps } from "react";
import {
  useLikedCoverStore,
  type LikedCoverPreset,
} from "@/lib/store/liked-cover";
import { useSettingsStore } from "@/lib/store/settings";
import { cn } from "@/lib/utils";

type CoverArt = {
  label: string;
  /** Any `background` shorthand: the four covers are gradients or a fill. */
  bg: string;
  /** Two of them are glass and read the wash behind the panel. */
  blur?: string;
  /** Hairline inside the tile's own edge. */
  ring: string;
  /** The heart on top of the art. */
  fill: string;
};

/**
 * The covers from the design handoff, in the order the picker shows
 * them. Values are the prototype's, down to the gradient stops.
 */
export const LIKED_COVERS: Record<LikedCoverPreset, CoverArt> = {
  ytubic: {
    label: "YTubic",
    bg: "radial-gradient(130% 110% at 22% 12%,#FF5F79,#E8214C 34%,#8E1230 68%,#2A0913)",
    ring: "var(--w140)",
    fill: "rgba(255,255,255,0.94)",
  },
  default: {
    label: "Default",
    bg: "linear-gradient(150deg,#6C4BFF 0%,#C93BC0 55%,#FF4E7A 100%)",
    ring: "var(--w120)",
    fill: "rgba(255,255,255,0.92)",
  },
  clear: {
    label: "Clear",
    bg: "var(--w055)",
    blur: "blur(18px)",
    ring: "var(--w120)",
    fill: "var(--liked-heart-glass)",
  },
  glow: {
    label: "Glow",
    bg: "radial-gradient(150% 130% at 100% 84%, rgba(250,31,75,0.3) 0%, rgba(250,31,75,0.16) 32%, rgba(250,31,75,0.05) 62%, var(--w040) 100%)",
    blur: "blur(18px)",
    ring: "var(--w120)",
    fill: "var(--liked-heart-glow)",
  },
};

export const LIKED_COVER_ORDER: LikedCoverPreset[] = [
  "ytubic",
  "default",
  "clear",
  "glow",
];

const HEART =
  "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z";

// Material's thumb_up (the YouTube-style glyph), for when the rating
// buttons are thumbs. The rows keep lucide's outline; this filled shape
// reads better at cover size.
const THUMB =
  "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z";

/** The tile itself, without reading the cover store (the picker's
 *  swatches use it directly). The glyph follows Appearance -> Rating
 *  buttons, so the cover matches what the rows show. */
export function LikedCoverArt({
  art,
  className,
  heart = 42,
  blur = true,
  ...props
}: {
  art: CoverArt;
  /** Heart width as a share of the tile. The design draws it larger on
   *  the small tiles, where a 42% glyph would read as a dot. */
  heart?: number;
  /**
   * Whether the two glass covers actually blur what is behind them.
   * Only the picker's swatches do. On the page itself a backdrop filter
   * re-samples its backdrop whenever another composited layer with one
   * appears over it — opening the picker, whose panel is also frosted,
   * drew a hard seam across the artwork. Nothing is lost by dropping
   * it: what sits behind the cover is the ambient wash, already blurred
   * past recognition, so the translucent fill carries the glass on its
   * own.
   */
  blur?: boolean;
} & ComponentProps<"span">) {
  const thumb = useSettingsStore((s) => s.ratingButtons === "both");
  return (
    <span
      aria-hidden
      {...props}
      className={cn("grid place-items-center overflow-hidden", className)}
      style={{
        background: art.bg,
        backdropFilter: blur ? art.blur : undefined,
        WebkitBackdropFilter: blur ? art.blur : undefined,
        boxShadow: `inset 0 0 0 1px ${art.ring}`,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill={art.fill}
        style={{ width: `${heart}%` }}
        aria-hidden
      >
        <path d={thumb ? THUMB : HEART} />
      </svg>
    </span>
  );
}

/**
 * Liked songs' artwork wherever it appears: the sidebar row, the
 * playlist hero, the picker's own preview. Reads the user's choice, so
 * every instance changes at once.
 */
export function LikedCover({
  className,
  heart,
  ...props
}: { heart?: number } & ComponentProps<"span">) {
  const preset = useLikedCoverStore((s) => s.preset);
  const custom = useLikedCoverStore((s) => s.custom);

  if (custom) {
    return (
      <span
        aria-hidden
        {...props}
        className={cn("block overflow-hidden", className)}
        style={{
          background: `url("${custom}") center/cover no-repeat`,
          boxShadow: "inset 0 0 0 1px var(--w140)",
        }}
      />
    );
  }

  return (
    <LikedCoverArt
      art={LIKED_COVERS[preset] ?? LIKED_COVERS.ytubic}
      className={className}
      heart={heart}
      blur={false}
      {...props}
    />
  );
}
