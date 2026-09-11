import { create } from "zustand";
import type { NonMusicSegment } from "@/lib/sponsorblock";

type State = {
  /** Non-music stretches of the stream that is playing right now, empty
   *  unless the setting is on and the source is a music video. Read by
   *  the engine to skip them and by the progress bar to mark them. */
  segments: NonMusicSegment[];
  setSegments: (segments: NonMusicSegment[]) => void;
};

export const useSponsorSegments = create<State>()((set) => ({
  segments: [],
  setSegments: (segments) => set({ segments }),
}));
