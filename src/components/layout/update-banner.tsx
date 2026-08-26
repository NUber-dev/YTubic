import {
  IconAlertTriangle,
  IconArrowDown,
  IconDownload,
  IconRefresh,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { useUpdateStore } from "@/lib/store/update";
import { beginUpdateInstall, restartToUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";

type CardConfig = {
  icon: ComponentType<IconProps>;
  /** Glyph size inside the tile; the two arrows are drawn at different weights. */
  iconClass: string;
  title: string;
  sub?: string;
  onClick?: () => void;
};

/**
 * Sits in the sidebar footer, just above Settings, and is the one
 * persistent surface for an available update. Rendered only while an
 * update is somewhere in the flow (phase !== "idle"); it mirrors the
 * shared update store so it can never disagree with the progress
 * toasts.
 *
 * available -> click downloads + installs; ready -> click restarts;
 * while downloading it is inert and shows a progress ring instead.
 *
 * Deliberately carries no accent at rest: the card reads as a normal
 * sidebar row one step lighter than the panel, and the only accent in
 * the whole thing is the progress arc. A tinted card and a linear bar
 * along the bottom edge were both tried and dropped — the bar gets
 * clipped by the radius, and the tint made a routine notice shout.
 */
export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);

  if (phase === "idle") return null;

  const busy = phase === "downloading" || phase === "installing";
  // `installing` has no progress of its own — it's the tail of the same
  // download, so it keeps the ring and pins it full.
  const pct = phase === "installing" ? 100 : (progress ?? 0);

  const cfg: CardConfig = {
    available: {
      icon: IconDownload,
      iconClass: "size-[15px]",
      title: "Update available",
      sub: version ? `Version ${version}` : undefined,
      onClick: () => void beginUpdateInstall(),
    },
    downloading: {
      icon: IconArrowDown,
      iconClass: "size-[13px]",
      title: "Downloading update",
      sub: progress != null ? `${progress}%` : "Starting…",
    },
    installing: {
      icon: IconArrowDown,
      iconClass: "size-[13px]",
      title: "Installing update",
      sub: "Almost done…",
    },
    ready: {
      icon: IconRefresh,
      iconClass: "size-[15px]",
      title: "Restart to update",
      sub: version ? `Version ${version} ready` : "Ready to install",
      onClick: () => restartToUpdate(),
    },
    error: {
      icon: IconAlertTriangle,
      iconClass: "size-[15px]",
      title: "Update failed",
      sub: "Click to retry",
      onClick: () => void beginUpdateInstall(),
    },
  }[phase];

  const Icon = cfg.icon;
  const label = cfg.sub ? `${cfg.title} · ${cfg.sub}` : cfg.title;

  return (
    <button
      type="button"
      onClick={cfg.onClick}
      disabled={!cfg.onClick}
      // Collapsed, the label is gone, so the state has to survive in the
      // native tooltip.
      title={label}
      aria-label={cfg.title}
      className={cn(
        "group/upd flex w-full items-center gap-[9px] rounded-[11px] border border-w080 bg-w050 px-[9px] py-2 text-left",
        "shadow-[inset_0_1px_0_var(--w060)] enabled:cursor-pointer enabled:hover:bg-w090 disabled:cursor-default",
        // Everything that separates the card from the rail's bare tile
        // is a value the browser can interpolate, so the chrome dissolves
        // over the same 220ms the panel takes rather than snapping off on
        // the first frame. The text column keeps its slot and simply
        // fades (see `data-sidebar-label` in index.css); `flex-1` with
        // `min-w-0` squeezes it to nothing as the panel narrows.
        "transition-[padding,border-width,border-color,border-radius,background-color,box-shadow] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
        // On the rail the card's own chrome drops away and the tile
        // becomes the whole control — it keeps its fill and ring so the
        // update still stands out among the flat nav rows. Hover moves
        // onto the tile with it, since an opaque tile would hide any
        // wash painted behind it. Border and padding go to zero so the
        // tile is the card: it then covers exactly the same 36x28 as a
        // nav row's hover pill, instead of a smaller square inset inside
        // one.
        "group-data-[collapsible=icon]:rounded-[9px] group-data-[collapsible=icon]:border-0",
        "group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0",
        "group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:hover:bg-transparent",
      )}
    >
      <span
        // A fixed box the width of the control, so whatever the tile is
        // doing inside it — full-width pill at rest, square while the
        // ring is up — stays centred. Without it the tile is just the
        // first flex item and a narrower one sits flush left.
        className={cn(
          "relative grid w-[26px] shrink-0 place-items-center",
          "transition-[width] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
          "group-data-[collapsible=icon]:w-9",
        )}
        role={busy ? "progressbar" : undefined}
        aria-valuenow={busy ? pct : undefined}
        aria-valuemin={busy ? 0 : undefined}
        aria-valuemax={busy ? 100 : undefined}
      >
        <span
          className={cn(
            "grid size-[26px] place-items-center rounded-md bg-w070 text-t3 shadow-[inset_0_0_0_1px_var(--w080)]",
            "transition-[width,height,border-radius,background-color,color] duration-[220ms] ease-[cubic-bezier(.32,.72,0,1)]",
            // The ring is round, so the tile under it goes round too
            // while the download runs.
            busy && "rounded-full",
            // On the rail the tile takes a nav row's footprint exactly,
            // so hovering it lights the same shape as hovering any row
            // above it. While the download runs it pulls back to a square
            // for the ring to circle — the size is transitioned, so that
            // is a glide, and it only happens while progress is showing.
            "group-data-[collapsible=icon]:h-7 group-data-[collapsible=icon]:w-9",
            busy && "group-data-[collapsible=icon]:size-7",
            "group-data-[collapsible=icon]:group-hover/upd:bg-w110",
          )}
        >
          <Icon className={cfg.iconClass} />
        </span>
        {busy ? (
          // A 2px arc 4px out from the tile: a conic gradient masked down
          // to a ring. Sized and centred rather than inset from the tile's
          // edges, so it stays a circle even when the tile under it is a
          // wider pill. No transition on the gradient — only `pct` moves,
          // and animating a conic stop just smears it.
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 size-[34px] -translate-x-1/2 -translate-y-1/2 rounded-full group-data-[collapsible=icon]:size-9"
            style={{
              background: `conic-gradient(var(--acc1) ${pct}%, var(--w110) 0)`,
              mask: RING_MASK,
              WebkitMask: RING_MASK,
            }}
          />
        ) : null}
      </span>

      <span data-sidebar-label className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[12.5px] font-semibold leading-tight tracking-[-0.005em] text-t1">
          {cfg.title}
        </span>
        {cfg.sub ? (
          <span className="truncate text-[10.5px] font-medium leading-tight text-t5">
            {cfg.sub}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px))";
