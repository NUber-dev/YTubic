import { create } from "zustand";

type State = {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
};

// Non-persisted so the overlay never survives a reload or leaks across
// windows through the shared layout-storage key.
export const useNowPlayingStore = create<State>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
