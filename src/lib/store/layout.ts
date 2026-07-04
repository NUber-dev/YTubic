import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LayoutMode = "right" | "bottom" | "floating";

type State = {
  mode: LayoutMode;
  /** Always-on-top toggle for the floating-player window. Persisted
   *  so a pinned window stays pinned after a close/reopen cycle. */
  floatingPinned: boolean;
  setMode: (mode: LayoutMode) => void;
  setFloatingPinned: (v: boolean) => void;
};

/**
 * Player layout preference. Three modes:
 *  - `right`    — fixed card on the right side of the window (default)
 *  - `bottom`   — compact horizontal bar pinned to the bottom of the page
 *  - `floating` — separate Tauri window that floats independently
 *
 * Persisted in localStorage so the user's choice survives restarts. The
 * floating window auto-spawns on startup if `floating` was the last
 * picked mode (logic in `app-shell.tsx`).
 */
export const useLayoutStore = create<State>()(
  persist(
    (set) => ({
      mode: "right",
      floatingPinned: false,
      setMode: (mode) => set({ mode }),
      setFloatingPinned: (floatingPinned) => set({ floatingPinned }),
    }),
    { name: "ytm-layout" },
  ),
);
