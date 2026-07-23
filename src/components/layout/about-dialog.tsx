import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { checkForUpdates } from "@/lib/updater";
import { IS_BETA_PLATFORM, IS_MAC } from "@/lib/platform";
import { openWhatsNew } from "@/lib/store/whats-new";
import { DiscordIcon, GithubIcon } from "@/components/shared/brand-icons";

const REPO_URL = "https://github.com/NUber-dev/YTubic";
const DISCORD_URL = "https://discord.gg/v7JGAWWWj";

const CREDITS: { name: string; role: string; url: string }[] = [
  {
    name: "yt-dlp",
    role: "audio streaming",
    url: "https://github.com/yt-dlp/yt-dlp",
  },
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
      <DialogContent
        className={cn("max-w-md", frostedDialogPanel)}
        overlayClassName={frostedDialogOverlay}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src="/ytubic-icon.svg" alt="" className="size-12" />
            <div className="flex flex-col items-start">
              <DialogTitle className="text-lg">YTubic</DialogTitle>
              {/* Version and the What's New link share one row so the
                  header stays two lines tall next to the 48px icon. */}
              <div className="flex items-center gap-2">
                <DialogDescription>
                  {version ? `Version ${version}` : " "}
                  {version && IS_BETA_PLATFORM
                    ? ` · beta for ${IS_MAC ? "macOS" : "Linux"}`
                    : ""}
                </DialogDescription>
                <button
                  type="button"
                  onClick={() => void openWhatsNew()}
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  What's new
                </button>
              </div>
            </div>
          </div>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Fast, responsive YouTube Music desktop client. Unofficial — not
          affiliated with, endorsed by, or sponsored by Google or YouTube.
          "YouTube" and "YouTube Music" are trademarks of Google LLC.
        </p>

        {IS_BETA_PLATFORM && (
          <p className="text-sm text-muted-foreground">
            The {IS_MAC ? "macOS" : "Linux"} build is in beta. If something
            breaks, please report it via the window menu (⋯ → Report an issue)
            or on{" "}
            <button
              type="button"
              onClick={link(`${REPO_URL}/issues`)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              GitHub
            </button>
            .
          </p>
        )}

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

        <div className="flex gap-2">
          <Button variant="outline" onClick={link(DISCORD_URL)}>
            <DiscordIcon />
            Discord
          </Button>
          <Button variant="outline" onClick={link(REPO_URL)}>
            <GithubIcon />
            GitHub
          </Button>
          <Button
            className="ms-auto"
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
