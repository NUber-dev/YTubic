import {
  AlertTriangleIcon,
  DownloadIcon,
  Loader2Icon,
  RotateCwIcon,
  type LucideIcon,
} from "lucide-react";
import { useUpdateStore } from "@/lib/store/update";
import { beginUpdateInstall, restartToUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";

type BannerConfig = {
  icon: LucideIcon;
  title: string;
  sub?: string;
  onClick?: () => void;
  /** Brand-tinted call to action (available / ready) vs neutral (busy). */
  accent: boolean;
  spin: boolean;
};

/**
 * Sits in the sidebar footer, just above Settings, and is the one
 * persistent surface for an available update. Visible only while an
 * update is somewhere in the flow (phase !== "idle"); it mirrors the
 * shared update store so it stays in step with the progress toasts.
 *
 * available -> click downloads + installs; ready -> click restarts;
 * during download/install it shows progress and isn't clickable.
 * Collapses to just the icon (with a native tooltip) when the sidebar
 * is in icon mode.
 */
export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);

  if (phase === "idle") return null;

  const cfg: BannerConfig = {
    available: {
      icon: DownloadIcon,
      title: "Update available",
      sub: version ?? undefined,
      onClick: () => void beginUpdateInstall(),
      accent: true,
      spin: false,
    },
    downloading: {
      icon: Loader2Icon,
      title: "Downloading update",
      sub: progress != null ? `${progress}%` : "Starting…",
      accent: false,
      spin: true,
    },
    installing: {
      icon: Loader2Icon,
      title: "Installing update",
      sub: "Almost done…",
      accent: false,
      spin: true,
    },
    ready: {
      icon: RotateCwIcon,
      title: "Restart to update",
      sub: version ?? undefined,
      onClick: () => restartToUpdate(),
      accent: true,
      spin: false,
    },
    error: {
      icon: AlertTriangleIcon,
      title: "Update failed",
      sub: "Click to retry",
      onClick: () => void beginUpdateInstall(),
      accent: false,
      spin: false,
    },
  }[phase];

  const Icon = cfg.icon;
  const interactive = !!cfg.onClick;
  const showBar = phase === "downloading" || phase === "installing";
  const pct = phase === "installing" ? 100 : progress;

  return (
    <button
      type="button"
      onClick={cfg.onClick}
      disabled={!interactive}
      title={cfg.sub ? `${cfg.title} · ${cfg.sub}` : cfg.title}
      className={cn(
        "relative flex w-full items-center gap-2.5 overflow-hidden rounded-md border p-2 text-left transition-colors",
        cfg.accent
          ? "border-primary/30 bg-primary/10 hover:bg-primary/15"
          : "border-border/70 bg-muted/50",
        !interactive && "cursor-default",
        "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1.5",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded",
          cfg.accent
            ? "bg-primary/15 text-primary"
            : "bg-background/60 text-muted-foreground",
        )}
      >
        <Icon className={cn("size-4", cfg.spin && "animate-spin")} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
        <span className="truncate text-xs font-medium leading-tight">
          {cfg.title}
        </span>
        {cfg.sub ? (
          <span className="truncate text-[11px] leading-tight text-muted-foreground">
            {cfg.sub}
          </span>
        ) : null}
      </span>
      {showBar ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/20 group-data-[collapsible=icon]:hidden">
          <span
            className={cn(
              "block h-full bg-primary transition-[width] duration-300 ease-out",
              pct == null && "animate-pulse",
            )}
            style={{ width: pct == null ? "100%" : `${pct}%` }}
          />
        </span>
      ) : null}
    </button>
  );
}
