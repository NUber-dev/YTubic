import { create } from "zustand";

type State = {
  /** Holds the audio element paused without disturbing `playing`. */
  waiting: boolean;
  setWaiting: (waiting: boolean) => void;
};

export const useVideoGateStore = create<State>()((set) => ({
  waiting: false,
  setWaiting: (waiting) => set({ waiting }),
}));
