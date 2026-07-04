import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How many queries we remember across sessions. We show only the top 5
 *  in the dropdown; the rest are kept around so dedupe reuses them. */
const MAX = 25;

type SearchHistoryState = {
  items: string[];
  push: (q: string) => void;
  remove: (q: string) => void;
  clear: () => void;
};

export const useSearchHistory = create<SearchHistoryState>()(
  persist(
    (set) => ({
      items: [],
      push: (q) =>
        set((state) => {
          const trimmed = q.trim();
          if (!trimmed) return state;
          // Move to front, dedupe (case-insensitive).
          const lower = trimmed.toLowerCase();
          const rest = state.items.filter((x) => x.toLowerCase() !== lower);
          return { items: [trimmed, ...rest].slice(0, MAX) };
        }),
      remove: (q) =>
        set((state) => ({
          items: state.items.filter((x) => x !== q),
        })),
      clear: () => set({ items: [] }),
    }),
    {
      name: "ytm:search-history",
      version: 1,
    },
  ),
);
