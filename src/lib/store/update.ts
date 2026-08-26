import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

/**
 * Where an available update sits in the download/install flow. The
 * sidebar banner and the progress toasts both read this one store, so
 * they can never disagree about what's happening.
 */
export type UpdatePhase =
  | "idle" // nothing to install
  | "available" // found, not started
  | "downloading"
  | "installing"
  | "ready" // installed, waiting for a restart
  | "error";

type State = {
  phase: UpdatePhase;
  version: string | null;
  /** 0-100 while downloading; null = size unknown (indeterminate). */
  progress: number | null;
  error: string | null;
  /**
   * The plugin's update handle. `null` in the dev preview, where the
   * flow runs on mock data with no real artifact. The installer and
   * the restart action branch on this to decide real vs simulated.
   */
  handle: Update | null;

  setAvailable: (version: string, handle: Update | null) => void;
  setDownloading: (progress: number | null) => void;
  setInstalling: () => void;
  setReady: () => void;
  setError: (message: string) => void;
  reset: () => void;
};

export const useUpdateStore = create<State>()((set) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,
  handle: null,
  setAvailable: (version, handle) =>
    set({ phase: "available", version, handle, progress: null, error: null }),
  setDownloading: (progress) => set({ phase: "downloading", progress }),
  setInstalling: () => set({ phase: "installing", progress: 100 }),
  setReady: () => set({ phase: "ready", progress: 100 }),
  setError: (error) => set({ phase: "error", error }),
  reset: () =>
    set({
      phase: "idle",
      version: null,
      progress: null,
      error: null,
      handle: null,
    }),
}));

// Dev-only handle for driving the sidebar update card by hand: the real
// flow needs a published release, and the dev fallback only seeds the
// "available" state. In the browser console:
//
//   __updateStore.getState().setAvailable("0.5.1", null)
//   __updateStore.getState().setDownloading(37)
//   __updateStore.getState().setReady()
//   __updateStore.getState().reset()
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__updateStore = useUpdateStore;
}
