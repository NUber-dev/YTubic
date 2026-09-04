import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeLocalStorage } from "./safe-storage";

/**
 * Tracks the user has disliked, remembered locally.
 *
 * YouTube Music keeps dislikes server-side but exposes no list of them
 * (the liked list is a playlist, dislikes are not), and browse responses
 * don't carry a per-track rating. So the thumbs-down state is whatever
 * was toggled from this app; a dislike made elsewhere shows as neutral
 * here until it is toggled again.
 */
type State = {
  ids: Record<string, true>;
  add: (videoId: string) => void;
  remove: (videoId: string) => void;
};

export const useDislikesStore = create<State>()(
  persist(
    (set) => ({
      ids: {},
      add: (videoId) => set((s) => ({ ids: { ...s.ids, [videoId]: true } })),
      remove: (videoId) =>
        set((s) => {
          if (!s.ids[videoId]) return s;
          const ids = { ...s.ids };
          delete ids[videoId];
          return { ids };
        }),
    }),
    {
      name: "ytm-dislikes",
      storage: createJSONStorage(() => safeLocalStorage),
    },
  ),
);

// A dislike toggled in the main window shows in the floating player (and
// the other way round) through the shared localStorage key.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-dislikes") void useDislikesStore.persist.rehydrate();
  });
}
