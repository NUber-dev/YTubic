import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The four covers the design ships. See `liked-cover.tsx` for the art. */
export type LikedCoverPreset = "ytubic" | "default" | "clear" | "glow";

type State = {
  preset: LikedCoverPreset;
  /**
   * A picture the user dropped in, already downscaled to a 512px square
   * and stored as a data URL. It wins over `preset`, which is kept so
   * removing the picture puts the previous swatch back rather than
   * dumping the user on the default.
   */
  custom: string | null;
  setPreset: (preset: LikedCoverPreset) => void;
  setCustom: (dataUrl: string) => void;
  clearCustom: () => void;
};

/**
 * Which artwork Liked songs wears. YouTube ships its own cover for the
 * playlist, but it is the one playlist a user can't re-cover on the web,
 * and it is the one they see most, so the design lets them choose here.
 *
 * Persisted locally and deliberately not tied to the account: it is a
 * decoration of this install, and nothing about it round-trips to
 * YouTube.
 */
export const useLikedCoverStore = create<State>()(
  persist(
    (set) => ({
      preset: "ytubic",
      custom: null,
      setPreset: (preset) => set({ preset, custom: null }),
      setCustom: (custom) => set({ custom }),
      clearCustom: () => set({ custom: null }),
    }),
    { name: "ytm-liked-cover" },
  ),
);
