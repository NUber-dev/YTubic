import { useState } from "react";
import { DownloadIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUpdateStore } from "@/lib/store/update";
import { openUpstreamReleaseNotes } from "@/lib/updater";

const UPDATE_COMMANDS = `git fetch upstream
git merge upstream/main
pnpm tauri build`;

/**
 * Launch reminder that upstream shipped a newer version.
 *
 * This is a fork, so "update" can't mean "install the official build": that
 * artifact carries none of our patches and would replace them (see
 * lib/updater.ts, which is why no self-install path exists). It means merge
 * upstream and rebuild — so this dialog nudges that, rather than offering a
 * button that would do the wrong thing.
 *
 * It deliberately re-opens on EVERY launch while we're behind: dismissal is
 * component state and is never persisted, because forgetting to merge is
 * exactly the failure this guards against.
 */
export function ForkUpdateDialog() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const handle = useUpdateStore((s) => s.handle);
  const [dismissed, setDismissed] = useState(false);

  // `handle` is null in the dev preview (mock update), so treat its fields as
  // optional rather than gating the whole dialog on them.
  const current = handle?.currentVersion;
  const notes = handle?.body?.trim();
  const open = phase === "available" && !dismissed;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(true);
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 px-6 pb-4 pt-6">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <DownloadIcon className="size-[18px]" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle className="text-lg font-bold leading-none">
                Upstream released {version}
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-snug">
                {current ? `This build is ${current}.` : "This build is behind."}{" "}
                Merge upstream and rebuild to pick up the new features.
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="app-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
              Don't install the official release over this one — it's the
              upstream build and has none of your fork's patches (the global
              volume hotkeys). That's why this build never updates itself.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Update your fork
            </h3>
            <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground/90">{UPDATE_COMMANDS}</pre>
            <p className="text-[13px] leading-snug text-muted-foreground">
              Resolve any conflicts, then reinstall from{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                src-tauri/target/release/bundle/nsis
              </code>
              .
            </p>
          </div>

          {notes ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What's in {version}
              </h3>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border/60 bg-muted/40 p-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {notes}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-6 py-4">
          <Button variant="outline" onClick={() => openUpstreamReleaseNotes()}>
            <ExternalLinkIcon />
            Release notes
          </Button>
          <Button onClick={() => setDismissed(true)}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
