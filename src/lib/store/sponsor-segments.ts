import { create } from "zustand";
import type { NonMusicSegment } from "@/lib/sponsorblock";

type State = {
  segments: NonMusicSegment[];
  setSegments: (segments: NonMusicSegment[]) => void;
};

export const useSponsorSegments = create<State>()((set) => ({
  segments: [],
  setSegments: (segments) => set({ segments }),
}));
