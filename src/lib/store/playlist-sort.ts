import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PlaylistSortMode =
  | "default"
  | "date-added-asc"
  | "title-asc"
  | "title-desc"
  | "artist-asc"
  | "duration-asc"
  | "duration-desc";

type State = {
  /** Map of playlistId → sort mode. Missing entries mean "default". */
  modes: Record<string, PlaylistSortMode>;
  setMode: (id: string, mode: PlaylistSortMode) => void;
};

/**
 * Per-playlist sort preference. Persisted so a user's chosen ordering
 * for Liked Songs (typically "date-added-asc" to see oldest likes
 * first) survives reloads.
 */
export const usePlaylistSortStore = create<State>()(
  persist(
    (set) => ({
      modes: {},
      setMode: (id, mode) =>
        set((s) => {
          if (mode === "default") {
            // Drop the entry to keep the map small and let new defaults
            // win if we ever change the default behavior.
            const { [id]: _drop, ...rest } = s.modes;
            void _drop;
            return { modes: rest };
          }
          return { modes: { ...s.modes, [id]: mode } };
        }),
    }),
    { name: "ytm-playlist-sort" },
  ),
);
