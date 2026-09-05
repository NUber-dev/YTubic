import { create } from "zustand";

type State = {
  /** True while some track list has rows selected. */
  active: boolean;
  setActive: (active: boolean) => void;
};

/**
 * Whether a bulk selection is up somewhere on the page. The selection
 * toolbar and the jump-to-current pill share the same corner of the
 * window, so the pill reads this to stay out of the way.
 */
export const useSelectionStore = create<State>()((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
