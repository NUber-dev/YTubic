import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeftIcon, ArrowRightIcon, MoreHorizontalIcon } from "lucide-react";
import {
  IconArrowsMinimize,
  IconBugFilled,
  IconDeviceDesktopFilled,
  IconExternalLink,
  IconInfoCircleFilled,
  IconLayoutBottombarFilled,
  IconLayoutFilled,
  IconLayoutSidebarRightFilled,
  IconMoonFilled,
  IconPaletteFilled,
  IconSettingsFilled,
  IconSunFilled,
} from "@tabler/icons-react";
import { IconPowerFilled } from "@/components/shared/filled-icons";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useFullscreenStore } from "@/lib/store/fullscreen";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
  WINDOW_CHROME_ATTR,
} from "@/components/ui/dialog";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import { IS_MAC } from "@/lib/platform";
import { openSettings } from "@/lib/store/settings-dialog";
import { AboutDialog } from "@/components/layout/about-dialog";

// Caption-bar nav buttons get just an icon-color shift on hover —
// the default ghost-button square highlight competes visually with
// the Windows-style min/max/close cells on the right side of the bar.
const NAV_BTN_CLS =
  "size-7 text-foreground/65 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent";

// Plain-vite dev in a regular browser has no Tauri backend —
// `getCurrentWindow()` throws on missing `__TAURI_INTERNALS__`, which
// used to crash the whole shell through the router's error boundary.
// Window controls are meaningless in a browser tab anyway.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Cross-platform title bar. Windows and Linux use the frameless base config,
 * so we draw the caption controls ourselves. macOS uses native traffic lights
 * over an overlay title bar; the navigation cluster is inset around them and
 * the Windows-style controls are omitted.
 *
 * Clicking our close button still goes through the Rust
 * `WindowEvent::CloseRequested` handler, which either hides the window
 * into the tray (default) or quits, per the "Close button" choice on
 * the Settings page. The "Quit" item in the More menu always
 * terminates the process regardless of that setting.
 */
export function TopBar() {
  const router = useRouter();
  const fullscreen = useFullscreenStore((s) => s.open);
  const [maximized, setMaximized] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [trueFullscreen, setTrueFullscreen] = useState(false);
  const [barRevealed, setBarRevealed] = useState(true);
  const restoreBoundsRef = useRef<{
    position: PhysicalPosition;
    size: PhysicalSize;
    wasMaximized: boolean;
  } | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!trueFullscreen) return;
    const REVEAL_ZONE = 8;
    const HOLD_ZONE = 40;
    const onMove = (e: MouseEvent) => {
      const zone = barRevealed ? HOLD_ZONE : REVEAL_ZONE;
      if (e.clientY <= zone) {
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        if (!barRevealed) setBarRevealed(true);
      } else if (hideTimerRef.current === null) {
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          setBarRevealed(false);
        }, 900);
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [trueFullscreen, barRevealed]);

  const toggleTrueFullscreen = async () => {
    const w = getCurrentWindow();
    if (!trueFullscreen) {
      const monitor = await currentMonitor();
      if (!monitor) return;
      restoreBoundsRef.current = {
        position: await w.outerPosition(),
        size: await w.outerSize(),
        wasMaximized: await w.isMaximized(),
      };
      await w.setAlwaysOnTop(true);
      await w.setResizable(false);
      await w.setShadow(false);
      await w.setPosition(monitor.position);
      await w.setSize(monitor.size);
      setTrueFullscreen(true);
      setBarRevealed(false);
    } else {
      await w.setAlwaysOnTop(false);
      await w.setResizable(true);
      await w.setShadow(true);
      const bounds = restoreBoundsRef.current;
      if (bounds?.wasMaximized) {
        await w.maximize();
      } else if (bounds) {
        await w.setSize(bounds.size);
        await w.setPosition(bounds.position);
      }
      setTrueFullscreen(false);
      setBarRevealed(true);
    }
  };

  const barHidden = trueFullscreen && !barRevealed;

  useEffect(() => {
    if (!IS_TAURI) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      void toggleTrueFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    // macOS has no custom maximize glyph to keep in sync; native traffic
    // lights own that state entirely.
    if (!IS_TAURI || IS_MAC) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    // Mirrors the cancelled-flag pattern used in audio-engine / app-shell:
    // `.onResized` is async, so its `.then` may resolve AFTER cleanup ran
    // in StrictMode's mount → unmount → remount cycle. Without the flag the
    // listener leaks twice and we get duplicated maximized-state updates.
    win
      .onResized(() => {
        win.isMaximized().then((m) => {
          if (!cancelled) setMaximized(m);
        });
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = () => getCurrentWindow();

  return (
    <>
      <header
        data-tauri-drag-region
        // Above the full-screen player (z-40) so the app menu stays
        // reachable there; the bar itself is transparent, so the blurred
        // cover runs up behind it.
        className={cn(
          "relative flex h-9 shrink-0 select-none items-center transition-transform duration-300",
          fullscreen ? "z-[45]" : "z-30",
          barHidden ? "-translate-y-full pointer-events-none" : "translate-y-0",
        )}
      >
        <div
          className={`flex items-center gap-1 ${IS_MAC ? "pl-[78px]" : "pl-2"}`}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                aria-label="More"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={() => openSettings()}>
                <IconSettingsFilled />
                Settings
              </DropdownMenuItem>
              <LayoutSubMenu />
              <ThemeSubMenu />

              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => setReportOpen(true)}>
                <IconBugFilled />
                Report Issue
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
                <IconInfoCircleFilled />
                About
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  void invoke("quit_app");
                }}
              >
                <IconPowerFilled />
                Quit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {IS_TAURI && trueFullscreen ? (
            <Button
              variant="ghost"
              size="icon"
              className={NAV_BTN_CLS}
              onClick={() => void toggleTrueFullscreen()}
              aria-label="Exit full screen"
            >
              <IconArrowsMinimize />
            </Button>
          ) : null}

          {/* No page and no sidebar to navigate while the full-screen
              player is up, so the three go with it. */}
          {fullscreen ? null : (
            <>
              <SidebarTrigger className={NAV_BTN_CLS} />
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                onClick={() => router.history.back()}
                aria-label="Back"
              >
                <ArrowLeftIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={NAV_BTN_CLS}
                onClick={() => router.history.forward()}
                aria-label="Forward"
              >
                <ArrowRightIcon />
              </Button>
            </>
          )}
        </div>

        {/* Drag spacer — fills remaining width so the user can grab
            almost anywhere in the bar to move the window. */}
        <div data-tauri-drag-region className="h-full flex-1" />

      </header>

      {/* Keeps the window draggable by its title bar while a dialog is
          open. The overlay covers the real header, so this transparent
          strip carries the drag region above it; `titlebar-drag-shield`
          (index.css) only turns pointer events on while Radix has the
          body scroll-locked, so at rest it can't steal clicks from the
          app menu and history buttons below it. It sits under the
          window controls, which need their own clicks. */}
      <div
        {...{ [WINDOW_CHROME_ATTR]: "" }}
        data-tauri-drag-region
        aria-hidden
        className="titlebar-drag-shield fixed inset-x-0 top-0 z-[55] h-(--titlebar-h) select-none"
      />

      {/* Rendered outside <header> on purpose. A dialog overlay covers
          the title bar, but minimize / maximize / close must stay usable
          — and `z-[60]` can only clear the overlay from the root
          stacking context. The header's own `relative z-30` establishes
          one, which would trap any z-index set inside it. Also
          `pointer-events-auto`, because Radix pins `pointer-events: none`
          on the body for as long as a dialog is open.

          The header's drag spacer runs the full width underneath this
          cluster; the buttons sit on top of it, so they take the click
          rather than starting a window drag.

          macOS is excluded: its traffic lights are native chrome and no
          web overlay reaches them. */}
      {!IS_MAC && (
        <div
          {...{ [WINDOW_CHROME_ATTR]: "" }}
          className={cn(
            "fixed right-0 top-0 z-[60] flex h-9 items-center transition-transform duration-300",
            barHidden
              ? "-translate-y-full pointer-events-none"
              : "translate-y-0 pointer-events-auto",
          )}
        >
          <button
            type="button"
            onClick={() => win().minimize()}
            aria-label="Minimize"
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            <MinimizeGlyph />
          </button>
          <button
            type="button"
            onClick={() => win().toggleMaximize()}
            aria-label={maximized ? "Restore" : "Maximize"}
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-titlebar-hover"
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </button>
          <button
            type="button"
            onClick={() => win().close()}
            aria-label="Close"
            className="flex h-full w-11 items-center justify-center text-foreground/85 transition-colors hover:bg-[#c42b1c] hover:text-white"
          >
            <CloseGlyph />
          </button>
        </div>
      )}

      <ReportIssueDialog open={reportOpen} onOpenChange={setReportOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
}

function LayoutSubMenu() {
  const mode = useLayoutStore((s) => s.mode);
  const setMode = useLayoutStore((s) => s.setMode);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <IconLayoutFilled />
        Layout
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as LayoutMode)}
        >
          <DropdownMenuRadioItem value="right">
            <IconLayoutSidebarRightFilled className="size-4" />
            Side card
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bottom">
            <IconLayoutBottombarFilled className="size-4" />
            Bottom bar
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="floating">
            <IconExternalLink className="size-4" />
            Floating window
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ThemeSubMenu() {
  const { theme, setTheme } = useTheme();
  // `theme` is undefined during the very first client render (next-themes
  // resolves it on mount). Fall back to "system" so the radio group has
  // a valid value and doesn't briefly render with nothing selected.
  const value = theme ?? "system";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <IconPaletteFilled />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => setTheme(v)}
        >
          <DropdownMenuRadioItem value="light">
            <IconSunFilled className="size-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <IconMoonFilled className="size-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <IconDeviceDesktopFilled className="size-4" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const REPO_ISSUES_URL = "https://github.com/NUber-dev/YTubic/issues/new";

/**
 * Feedback form that hands off to GitHub: Submit opens a prefilled
 * new-issue page in the default browser with the app version and OS
 * appended, so reports arrive with the diagnostics we always ask for.
 * Voting/discussion happens on GitHub — no backend of our own.
 */
function ReportIssueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
    }
  }, [open]);

  const submit = async () => {
    if (!body.trim()) return;
    let version = "unknown";
    try {
      version = await getVersion();
    } catch {
      /* non-Tauri context (plain vite dev) — keep "unknown" */
    }
    const fullBody = [
      body.trim(),
      "",
      "---",
      `App version: ${version}`,
      `OS: ${navigator.userAgent}`,
    ].join("\n");
    const params = new URLSearchParams({ body: fullBody });
    if (title.trim()) params.set("title", title.trim());
    try {
      await openUrl(`${REPO_ISSUES_URL}?${params}`);
      toast.success("Thanks! Finish submitting the issue in your browser.");
      onOpenChange(false);
    } catch (e) {
      toast.error("Couldn't open the browser", { description: String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={frostedDialogOverlay}
        className={cn(
          "w-[560px] max-w-[calc(100vw-2rem)] gap-4 rounded-2xl px-[26px] pb-[22px] pt-6 shadow-[0_30px_70px_-20px_var(--k850)] sm:max-w-[560px]",
          frostedDialogPanel,
        )}
      >
        {/* Catch-light along the top edge, as on the other dialogs. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <DialogClose className="absolute right-4 top-4 z-[2] grid size-7 cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2">
          <IconX className="size-3" />
          <span className="sr-only">Close</span>
        </DialogClose>

        {/* Right padding clears the close button. */}
        <DialogHeader className="gap-2 pr-[34px]">
          <DialogTitle className="text-2xl font-bold leading-none tracking-[-0.02em] text-t1">
            Report an issue
          </DialogTitle>
          <DialogDescription className="text-[13.5px] leading-[1.5] text-t4 text-pretty">
            Tell us what went wrong or what you'd like to see. Submitting
            opens a prefilled GitHub issue in your browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary (optional)"
          />
          {/* Same surface as `Input`, minus its fixed height. */}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What happened? Steps to reproduce, expected vs actual…"
            rows={7}
            className="w-full resize-none rounded-lg border border-w120 bg-w050 px-3 py-3 text-[13.5px] leading-[1.5] text-t2 outline-none transition-[background-color,border-color,box-shadow] duration-[140ms] placeholder:text-tph hover:border-w200 hover:bg-w080 focus-visible:border-acc1 focus-visible:bg-w070 focus-visible:ring-[3px] focus-visible:ring-[rgba(var(--acc1rgb),0.18)]"
          />
        </div>

        <DialogFooter className="gap-2.5 pt-0.5">
          <Button
            variant="secondary"
            size="lg"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="lg" onClick={() => void submit()} disabled={!body.trim()}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Hand-drawn 10×10 SVGs match the Windows 11 caption-button glyphs
   more faithfully than Lucide icons (which are designed at 24px and
   look chunky at this size). */

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreGlyph() {
  // Front square is a full outlined rect; back square is drawn as an
  // L-shape (top + right edge only) so we don't have to fill the
  // front rect with the background color — important here because
  // the title bar is transparent over the blurred album art behind.
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path
        d="M2.5 0.5 H9.5 V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
