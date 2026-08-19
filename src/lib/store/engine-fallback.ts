import { create } from "zustand";

type State = {
  fallbackForTrackKey: string | null;
  setFallbackForTrackKey: (key: string | null) => void;
};

export const useEngineFallbackStore = create<State>((set) => ({
  fallbackForTrackKey: null,
  setFallbackForTrackKey: (fallbackForTrackKey) => set({ fallbackForTrackKey }),
}));

export function trackKeyFor(index: number, streamVideoId: string | undefined): string | null {
  if (index < 0 || !streamVideoId) return null;
  return `${index}:${streamVideoId}`;
}
