import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconCheck,
  IconMugFilled,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { checkForUpdates, beginUpdateInstall } from "@/lib/updater";
import { useUpdateStore } from "@/lib/store/update";
import { IS_BETA_PLATFORM, IS_MAC } from "@/lib/platform";
import { openWhatsNew } from "@/lib/store/whats-new";
import { DiscordIcon, GithubIcon, XIcon } from "@/components/shared/brand-icons";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/NUber-dev/YTubic";
const DISCORD_URL = "https://discord.gg/4gccUpZyYH";
const X_URL = "https://x.com/NUber_ux";
// Donatello. The button wears a generic Tabler glyph rather than
// their mark — the brand is not recognisable enough to carry the
// meaning on its own.
const DONATE_URL = "https://donatello.to/NUber";

// Rendered column-first into a 4-row grid, so this order reads down the
// left column and then down the right one.
const CREDITS: { name: string; role: string; url: string }[] = [
  { name: "Tauri", role: "app shell", url: "https://tauri.app" },
  { name: "TanStack", role: "router + query", url: "https://tanstack.com" },
  { name: "shadcn/ui", role: "components", url: "https://ui.shadcn.com" },
  {
    name: "yt-dlp",
    role: "audio streaming",
    url: "https://github.com/yt-dlp/yt-dlp",
  },
  { name: "LRCLIB", role: "synced lyrics", url: "https://lrclib.net" },
  {
    name: "YouTube Music",
    role: "synced lyrics",
    url: "https://music.youtube.com",
  },
  { name: "Genius", role: "lyrics", url: "https://genius.com" },
  { name: "Musixmatch", role: "lyrics", url: "https://www.musixmatch.com" },
];

// Footer icon button — 38px, 10px radius, on the design's `--w060` fill.
const FOOTER_BTN =
  "grid size-9 place-items-center rounded-[10px] border border-w120 bg-w060 " +
  "text-t3 transition-colors duration-[140ms] hover:bg-w120 hover:text-t1 " +
  "cursor-pointer [&_svg]:size-4";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const phase = useUpdateStore((s) => s.phase);
  const nextVersion = useUpdateStore((s) => s.version);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  // The design replaces the old "Check for updates" button with a
  // footer status line, so opening the dialog is what runs the check.
  // Silent: the store drives the status line, and a toast on top of it
  // would say the same thing twice.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChecking(true);
    void checkForUpdates({ silent: true }).finally(() => {
      if (!cancelled) setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const link = (url: string) => () => {
    void openUrl(url);
  };

  const updateReady = phase !== "idle" && phase !== "error";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-w-[560px] gap-0 overflow-hidden rounded-2xl p-0 shadow-[0_30px_70px_-20px_var(--k850)] sm:max-w-[560px]",
          frostedDialogPanel,
        )}
        overlayClassName={frostedDialogOverlay}
      >
        {/* Catch-light along the top edge, per the design. Inset by 1px
            on each side so it stops at the border rather than over it. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <DialogClose className="absolute right-4 top-4 z-[2] grid size-7 cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2">
          <IconX className="size-3" />
          <span className="sr-only">Close</span>
        </DialogClose>

        <div className="flex flex-col gap-4 px-7 pb-0 pt-7">
          {/* Right padding clears the close button. */}
          <div className="flex items-center gap-4 pr-[34px]">
            <img
              src="/ytubic-icon.svg"
              alt=""
              // The design draws a 16px squircle here, but our icon is a
              // circular disc — a box-shadow follows the element's radius,
              // so at 16px the accent glow leaked out as square corners.
              className="size-14 shrink-0 rounded-full shadow-[0_6px_18px_-6px_rgba(var(--acc1rgb),0.35)]"
            />
            <div className="flex min-w-0 flex-col gap-[9px]">
              <DialogTitle className="text-[23px] font-bold leading-none tracking-[-0.02em] text-t1">
                YTubic
              </DialogTitle>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-t5">
                  {version ? `Version ${version}` : " "}
                  {version && IS_BETA_PLATFORM
                    ? ` · beta for ${IS_MAC ? "macOS" : "Linux"}`
                    : ""}
                </span>
                <span aria-hidden className="h-3 w-px bg-w140" />
                <button
                  type="button"
                  // What's New replaces this dialog rather than stacking
                  // on top of it — two panels over two overlays reads as
                  // a bug, and there's nothing to come back to here.
                  onClick={() => {
                    onOpenChange(false);
                    void openWhatsNew();
                  }}
                  className="cursor-pointer text-[13px] font-semibold text-acc1 underline-offset-2 hover:underline"
                >
                  What's new
                </button>
              </div>
            </div>
          </div>

          <DialogDescription className="text-[13.5px] leading-[1.55] text-t4 text-pretty">
            Fast, responsive YouTube Music desktop client. Unofficial — not
            affiliated with, endorsed by, or sponsored by Google or YouTube.
            "YouTube" and "YouTube Music" are trademarks of Google LLC.
          </DialogDescription>

          {IS_BETA_PLATFORM && (
            <p className="text-[13.5px] leading-[1.55] text-t4 text-pretty">
              The {IS_MAC ? "macOS" : "Linux"} build is in beta. If something
              breaks, please report it via the window menu (⋯ → Report an
              issue) or on{" "}
              <button
                type="button"
                onClick={link(`${REPO_URL}/issues`)}
                className="cursor-pointer underline underline-offset-2 hover:text-t2"
              >
                GitHub
              </button>
              .
            </p>
          )}

          <div className="mt-1 flex flex-col gap-3 rounded-xl border border-w075 bg-w028 px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-t5">
                Powered by
              </span>
              <span className="text-xs text-t6">
                Free software ·{" "}
                <button
                  type="button"
                  onClick={link(`${REPO_URL}/blob/main/LICENSE`)}
                  className="cursor-pointer text-t4 underline underline-offset-2 hover:text-t2"
                >
                  GPL-3.0
                </button>
              </span>
            </div>
            {/* Column-first so the list reads down each column rather
                than across the pair. */}
            <ul className="grid grid-flow-col grid-cols-2 grid-rows-4 gap-x-6 gap-y-[9px]">
              {CREDITS.map((c) => (
                <li
                  key={c.name}
                  className="flex items-baseline gap-[7px] text-[12.5px] text-t6"
                >
                  <button
                    type="button"
                    onClick={link(c.url)}
                    className="cursor-pointer font-semibold text-t2 underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </button>
                  {c.role}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* No rule above it: the credits panel already reads as a block,
            and the footer sits on the same 28px inset as every other
            edge of the card. */}
        <div className="flex items-center gap-2 p-7">
          <div className="flex min-w-0 flex-1 items-center gap-[9px]">
            {checking ? (
              <>
                <IconLoader2 className="size-3.5 animate-spin text-t6" />
                <span className="text-[12.5px] text-t5">
                  Checking for updates…
                </span>
              </>
            ) : updateReady ? (
              <>
                {/* The ring is a box-shadow, not a border, so the dot
                    keeps its 7px size and the glow sits outside it. */}
                <span
                  aria-hidden
                  className="size-[7px] shrink-0 rounded-full bg-acc1 shadow-[0_0_0_4px_rgba(var(--acc1rgb),0.18)]"
                />
                <span className="text-[12.5px] text-t2">
                  {nextVersion ? `Version ${nextVersion} available` : "Update available"}
                </span>
                <button
                  type="button"
                  onClick={() => void beginUpdateInstall()}
                  className="cursor-pointer text-[12.5px] font-semibold text-acc1 underline-offset-2 hover:underline"
                >
                  Update
                </button>
              </>
            ) : (
              <>
                <IconCheck
                  className="size-3.5 shrink-0 text-[#7FCE9B]"
                  stroke={2.4}
                />
                <span className="text-[12.5px] text-t5">
                  You're on the latest version
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={link(DISCORD_URL)}
            aria-label="Discord"
            title="Discord"
            className={FOOTER_BTN}
          >
            <DiscordIcon />
          </button>
          <button
            type="button"
            onClick={link(REPO_URL)}
            aria-label="GitHub"
            title="GitHub"
            className={FOOTER_BTN}
          >
            <GithubIcon />
          </button>
          <button
            type="button"
            onClick={link(X_URL)}
            aria-label="X"
            title="X"
            className={cn(FOOTER_BTN, "[&_svg]:size-4")}
          >
            <XIcon />
          </button>
          <button
            type="button"
            onClick={link(DONATE_URL)}
            className={cn(
              FOOTER_BTN,
              // The one labelled button in the row: same fill and height,
              // sized to its text instead of square. `flex` replaces the
              // base `grid`, which would stack the mark above the label.
              "flex w-auto items-center gap-2 px-3.5 text-[13.5px] font-semibold text-t1 [&_svg]:size-4",
            )}
          >
            <IconMugFilled />
            Support
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
