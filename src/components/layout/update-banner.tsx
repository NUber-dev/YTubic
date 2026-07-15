import { DownloadIcon } from "lucide-react";
import { useUpdateStore } from "@/lib/store/update";
import { openUpstreamReleaseNotes } from "@/lib/updater";
import { cn } from "@/lib/utils";

/**
 * Sits in the sidebar footer, just above Settings: the persistent reminder
 * that upstream shipped a newer version.
 *
 * Fork note: this build never installs an update (see lib/updater.ts — the
 * upstream artifact would drop this fork's patches), so the banner is purely
 * informational. Clicking it opens upstream's release notes; the
 * merge-and-rebuild flow is spelled out by ForkUpdateDialog at launch.
 *
 * Collapses to just the icon (with a native tooltip) when the sidebar is in
 * icon mode.
 */
export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);

  if (phase !== "available") return null;

  return (
    <button
      type="button"
      onClick={() => openUpstreamReleaseNotes()}
      title={
        version ? `Update available · ${version} — view notes` : "Update available"
      }
      className={cn(
        "relative flex w-full items-center gap-2.5 overflow-hidden rounded-md border p-2 text-left transition-colors",
        "border-primary/30 bg-primary/10 hover:bg-primary/15",
        "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1.5",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded bg-primary/15 text-primary">
        <DownloadIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
        <span className="truncate text-xs font-medium leading-tight">
          Update available
        </span>
        <span className="truncate text-[11px] leading-tight text-muted-foreground">
          {version ? `${version} · view notes` : "View notes"}
        </span>
      </span>
    </button>
  );
}
