import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { checkForUpdates } from "@/lib/updater";
import { openWhatsNew } from "@/lib/store/whats-new";

const REPO_URL = "https://github.com/NUber-dev/YTubic";
const KOFI_URL = "https://ko-fi.com/nuberr";

const CREDITS: { name: string; role: string; url: string }[] = [
  { name: "yt-dlp", role: "audio streaming", url: "https://github.com/yt-dlp/yt-dlp" },
  { name: "LRCLIB", role: "synced lyrics", url: "https://lrclib.net" },
  { name: "Musixmatch", role: "lyrics", url: "https://www.musixmatch.com" },
  { name: "Genius", role: "lyrics", url: "https://genius.com" },
  { name: "Tauri", role: "app shell", url: "https://tauri.app" },
  { name: "shadcn/ui", role: "components", url: "https://ui.shadcn.com" },
  { name: "TanStack", role: "router + query", url: "https://tanstack.com" },
];

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  const link = (url: string) => () => {
    void openUrl(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src="/ytubic-icon.svg" alt="" className="size-12" />
            <div className="flex flex-col items-start">
              <DialogTitle className="text-lg">YTubic</DialogTitle>
              <DialogDescription>
                {version ? `Version ${version}` : " "}
              </DialogDescription>
              <button
                type="button"
                onClick={() => void openWhatsNew()}
                className="mt-0.5 text-xs text-primary underline-offset-2 hover:underline"
              >
                What's new
              </button>
            </div>
          </div>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Fast, responsive YouTube Music desktop client. Unofficial — not
          affiliated with, endorsed by, or sponsored by Google or YouTube.
          "YouTube" and "YouTube Music" are trademarks of Google LLC.
        </p>

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Powered by
          </p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
            {CREDITS.map((c) => (
              <li key={c.name} className="text-sm">
                <button
                  type="button"
                  onClick={link(c.url)}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {c.name}
                </button>{" "}
                <span className="text-muted-foreground">— {c.role}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          Free software under the{" "}
          <button
            type="button"
            onClick={link(`${REPO_URL}/blob/main/LICENSE`)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            GPL-3.0 license
          </button>
          .
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={link(KOFI_URL)}>
            ☕ Support
          </Button>
          <Button variant="outline" onClick={link(REPO_URL)}>
            GitHub
          </Button>
          <Button
            onClick={() => {
              void checkForUpdates({ silent: false });
            }}
          >
            Check for updates
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
