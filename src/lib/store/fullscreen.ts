import { create } from "zustand";

type State = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/**
 * Whether the full-screen now-playing view is up. Ephemeral: it is
 * opened from the player card's cover, the bottom bar's button, and
 * closed by its own Exit pill or Escape, so it lives in a store rather
 * than any one of those components.
 */
export const useFullscreenStore = create<State>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openFullscreen(): void {
  useFullscreenStore.getState().setOpen(true);
}
