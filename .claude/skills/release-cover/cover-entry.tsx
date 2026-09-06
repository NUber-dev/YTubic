// Release-cover entry. Copied into src/ by .claude/skills/release-cover/render.py
// for one build and removed afterwards; never part of the app.
import React, { useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  useSettingsDialog,
  type SettingsTab,
} from "@/lib/store/settings-dialog";
import { usePlaybackSettings } from "@/lib/store/playback-settings";
import "./index.css";
import "./lib/interface-font";

const params = new URLSearchParams(window.location.search);

// ?view=settings:<tab>
const view = params.get("view") ?? "settings:playback";
const [subject, tab] = view.split(":");
if (subject === "settings") {
  useSettingsDialog.setState({
    open: true,
    tab: (tab as SettingsTab) || "playback",
  });
}

// ?state={"crossfadeSec":6,...} merged into the playback settings store
const stateJson = params.get("state");
if (stateJson) {
  try {
    usePlaybackSettings.setState(JSON.parse(stateJson));
  } catch {
    // a bad JSON just leaves the defaults
  }
}

/* The lava-lamp blobs (dark spots under the wash) plus four washes. */
const BLOBS =
  "radial-gradient(circle 230px at 34% 60%, rgba(6,3,5,0.98) 0%, rgba(6,3,5,0.7) 50%, transparent 100%), radial-gradient(circle 170px at 63% 28%, rgba(6,3,5,0.95) 0%, rgba(6,3,5,0.6) 55%, transparent 100%), radial-gradient(circle 260px at 84% 64%, rgba(6,3,5,0.95) 0%, rgba(6,3,5,0.6) 55%, transparent 100%), radial-gradient(circle 150px at 16% 26%, rgba(6,3,5,0.9) 0%, transparent 100%), radial-gradient(circle 200px at 50% 92%, rgba(6,3,5,0.95) 0%, rgba(6,3,5,0.6) 55%, transparent 100%), radial-gradient(circle 120px at 76% 10%, rgba(6,3,5,0.85) 0%, transparent 100%), radial-gradient(circle 140px at 8% 70%, rgba(6,3,5,0.9) 0%, transparent 100%)";
const PALETTES: Record<string, string> = {
  sea: `${BLOBS}, radial-gradient(44% 56% at 22% 22%, #4fd6c8 0%, #1f8fa0 40%, transparent 74%), radial-gradient(40% 50% at 68% 12%, #2e63d9 0%, transparent 66%), radial-gradient(46% 56% at 10% 88%, #12384f 0%, transparent 70%), radial-gradient(55% 65% at 90% 80%, #070b12 0%, #0d1a2a 55%, transparent 100%), linear-gradient(120deg, #2aa7a8 0%, #1c3e73 48%, #090c14 100%)`,
  ember: `${BLOBS}, radial-gradient(44% 56% at 24% 22%, #ff6a5a 0%, #fa1f4b 38%, transparent 74%), radial-gradient(40% 50% at 70% 14%, #ff3040 0%, #b80f2c 40%, transparent 68%), radial-gradient(46% 56% at 10% 88%, #7a0a22 0%, transparent 70%), radial-gradient(55% 65% at 90% 82%, #12040a 0%, #2a0810 55%, transparent 100%), linear-gradient(120deg, #f52a48 0%, #8c0f2a 48%, #1a050b 100%)`,
  amber: `${BLOBS}, radial-gradient(44% 56% at 24% 20%, #ffc36a 0%, #f28a2c 42%, transparent 74%), radial-gradient(38% 48% at 60% 10%, #e9762c 0%, transparent 66%), radial-gradient(46% 56% at 8% 86%, #8a3d14 0%, transparent 70%), radial-gradient(55% 65% at 90% 80%, #120a08 0%, #2a150c 55%, transparent 100%), linear-gradient(120deg, #e07a2c 0%, #7a3a15 48%, #140c0a 100%)`,
  dusk: `${BLOBS}, radial-gradient(44% 56% at 22% 22%, #ff4f78 0%, #b8235a 40%, transparent 74%), radial-gradient(40% 50% at 68% 12%, #7b3fd6 0%, transparent 66%), radial-gradient(46% 56% at 10% 88%, #4a1550 0%, transparent 70%), radial-gradient(55% 65% at 90% 80%, #0d0a14 0%, #1c1026 55%, transparent 100%), linear-gradient(120deg, #c9366a 0%, #4b2472 48%, #0f0b16 100%)`,
};
const palette = PALETTES[params.get("bg") ?? "sea"] ?? PALETTES.sea;
const showSubject = !params.has("nodialog");

/**
 * The app's ambient backdrop with a synthetic "album cover" in place of
 * the playing track's art. Same classes as BackgroundCover, lifted from
 * opacity-30 so the wash carries a still image.
 */
function Backdrop() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full scale-125 blur-3xl saturate-150 brightness-100 opacity-[0.72]"
        style={{ background: palette }}
      />
      <div
        aria-hidden
        className="bg-cover-noise pointer-events-none absolute inset-0"
      />
    </>
  );
}

/** ?move=<Row title>|<Before row title>: staging-only row reorder. */
function Reorder() {
  const spec = params.get("move");
  useLayoutEffect(() => {
    if (!spec) return;
    const [what, before] = spec.split("|");
    const tick = () => {
      const spans = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"] span'),
      );
      const a = spans.find((s) => s.textContent === what);
      const b = spans.find((s) => s.textContent === before);
      const row = (el?: HTMLElement) => el?.closest<HTMLElement>(".py-4");
      const ra = row(a);
      const rb = row(b);
      if (!ra || !rb || !rb.parentElement) return false;
      rb.parentElement.insertBefore(ra, rb);
      return true;
    };
    if (tick()) return;
    const id = window.setInterval(() => {
      if (tick()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [spec]);
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <div className="relative h-screen w-screen overflow-hidden bg-background">
            <Backdrop />
            {showSubject && subject === "settings" ? <SettingsDialog /> : null}
            <Reorder />
          </div>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
