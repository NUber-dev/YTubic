import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  /**
   * Section titles in the order the user wants them. Titles the feed
   * returns that are not listed here fall in after the listed ones, in
   * the feed's own order, so a new section still shows up.
   */
  order: string[];
  /** Section titles the user switched off. */
  hidden: string[];
  /**
   * When each arranged or hidden title was last seen in the feed. A
   * title the feed has stopped sending is dropped from `order` and
   * `hidden` once it has been gone for `STALE_AFTER_MS`, so the store
   * does not collect the seasonal shelves YouTube retires.
   */
  lastSeen: Record<string, number>;
  setOrder: (order: string[]) => void;
  setHidden: (title: string, hidden: boolean) => void;
  /** Called with every title the feed has loaded; prunes what is stale. */
  noteSeen: (titles: string[]) => void;
  reset: () => void;
};

/**
 * Two weeks, not one load: the feed is paged, so a single load rarely
 * shows every section, and YouTube omits shelves at random between
 * visits. A section that has not turned up in that long is gone.
 */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How the home feed's sections are arranged. YouTube keys nothing about
 * a shelf across refreshes except its title, so the title is the
 * identity here; a shelf whose title changes simply reads as new.
 */
export const useHomeSectionsStore = create<State>()(
  persist(
    (set) => ({
      order: [],
      hidden: [],
      lastSeen: {},
      setOrder: (order) => set({ order }),
      setHidden: (title, hidden) =>
        set((s) => ({
          hidden: hidden
            ? s.hidden.includes(title)
              ? s.hidden
              : [...s.hidden, title]
            : s.hidden.filter((t) => t !== title),
        })),
      noteSeen: (titles) =>
        set((s) => {
          const now = Date.now();
          const seen = new Set(titles);
          const lastSeen: Record<string, number> = {};
          const alive = (t: string) => {
            // A title with no record yet (arranged before this field
            // existed) counts as seen now, so it gets its full grace.
            const at = seen.has(t) ? now : (s.lastSeen[t] ?? now);
            if (now - at > STALE_AFTER_MS) return false;
            lastSeen[t] = at;
            return true;
          };
          const order = s.order.filter(alive);
          const hidden = s.hidden.filter(alive);
          return { order, hidden, lastSeen };
        }),
      reset: () => set({ order: [], hidden: [], lastSeen: {} }),
    }),
    { name: "ytm-home-sections" },
  ),
);

/**
 * The titles as the user arranged them, with any the feed has that the
 * user has not placed yet appended in feed order. Used both to lay out
 * the page and to list the rows in the configure dialog.
 */
export function arrangeTitles(feed: string[], order: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...order, ...feed]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
