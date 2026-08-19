import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  LayoutDashboardIcon,
  PanelRightIcon,
  PanelBottomIcon,
  ExternalLinkIcon,
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  BugIcon,
  DownloadIcon,
  InfoIcon,
  PowerIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
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
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import { IS_MAC } from "@/lib/platform";
import { openSettings } from "@/lib/store/settings-dialog";
import { checkForUpdates } from "@/lib/updater";
import { AboutDialog } from "@/components/layout/about-dialog";
import { ReportIssueDialog } from "@/components/layout/report-issue-dialog";

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
  const [maximized, setMaximized] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

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
        className="relative z-30 flex h-9 shrink-0 select-none items-center"
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
                <SettingsIcon />
                Settings
              </DropdownMenuItem>
              <LayoutSubMenu />
              <ThemeSubMenu />

              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => setReportOpen(true)}>
                <BugIcon />
                Report Issue
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void checkForUpdates({ silent: false });
                }}
              >
                <DownloadIcon />
                Check for Updates
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
                <InfoIcon />
                About
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={() => {
                  void invoke("quit_app");
                }}
              >
                <PowerIcon />
                Quit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

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
        </div>

        {/* Drag spacer — fills remaining width so the user can grab
            almost anywhere in the bar to move the window. */}
        <div data-tauri-drag-region className="h-full flex-1" />

        {!IS_MAC && (
          <div className="flex h-full items-center">
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
      </header>

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
        <LayoutDashboardIcon />
        Layout
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as LayoutMode)}
        >
          <DropdownMenuRadioItem value="right">
            <PanelRightIcon className="size-4" />
            Side card
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bottom">
            <PanelBottomIcon className="size-4" />
            Bottom bar
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="floating">
            <ExternalLinkIcon className="size-4" />
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
        <PaletteIcon />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-40">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => setTheme(v)}
        >
          <DropdownMenuRadioItem value="light">
            <SunIcon className="size-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon className="size-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon className="size-4" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
