import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CloseButtonAction = "tray" | "quit";
export type CacheAutoCleanPeriod = "off" | "daily" | "weekly" | "monthly";
export type BackgroundMode = "ambient" | "plain";

type State = {
  /** What the title-bar ✕ does: hide to tray (default) or quit. */
  closeAction: CloseButtonAction;
  /** Cadence of the background sweep that deletes cached tracks not
   *  in the user's library (see `lib/cache-cleanup.ts`). */
  cacheAutoClean: CacheAutoCleanPeriod;
  /** Unix ms of the last completed sweep. 0 = never ran. */
  lastCacheCleanAt: number;
  /** Window backdrop: "ambient" tints with blurred album art,
   *  "plain" keeps the flat theme background. */
  background: BackgroundMode;
  /** System toast on track change while the app is in the background
   *  (see `lib/playback-notifications.ts`). */
  playbackNotifications: boolean;
  setCloseAction: (v: CloseButtonAction) => void;
  setCacheAutoClean: (v: CacheAutoCleanPeriod) => void;
  markCacheCleaned: () => void;
  setBackground: (v: BackgroundMode) => void;
  setPlaybackNotifications: (v: boolean) => void;
};

/**
 * General app preferences editable from the Settings page. Persisted
 * in localStorage like the other stores; anything Rust needs to act on
 * (close behavior) is mirrored over IPC by a sync hook rather than
 * read from disk on the Rust side.
 */
export const useSettingsStore = create<State>()(
  persist(
    (set) => ({
      closeAction: "tray",
      cacheAutoClean: "off",
      lastCacheCleanAt: 0,
      background: "ambient",
      playbackNotifications: false,
      setCloseAction: (closeAction) => set({ closeAction }),
      setCacheAutoClean: (cacheAutoClean) => set({ cacheAutoClean }),
      markCacheCleaned: () => set({ lastCacheCleanAt: Date.now() }),
      setBackground: (background) => set({ background }),
      setPlaybackNotifications: (playbackNotifications) =>
        set({ playbackNotifications }),
    }),
    { name: "ytm-settings" },
  ),
);

// The main and floating-player windows are separate JS contexts sharing
// the `ytm-settings` localStorage key (same pattern as `ytm-layout`).
// Re-hydrate on the cross-window `storage` event so e.g. switching the
// Background mode in the main window restyles the floating player live.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-settings") {
      void useSettingsStore.persist.rehydrate();
    }
  });
}

/**
 * Mirror the persisted close-button preference into Rust, where the
 * actual `CloseRequested` handling lives (it must cover every close
 * path — title-bar ✕, Alt+F4, taskbar Close). Mounted once in
 * AppShell: pushes the persisted value right after launch, then again
 * on every change from the Settings page.
 */
export function useCloseBehaviorSync(): void {
  const closeAction = useSettingsStore((s) => s.closeAction);
  useEffect(() => {
    invoke("set_close_behavior", {
      quitOnClose: closeAction === "quit",
    }).catch(() => {
      /* plain-vite dev without a Tauri backend — nothing to sync */
    });
  }, [closeAction]);
}
