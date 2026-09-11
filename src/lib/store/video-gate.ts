import { create } from "zustand";

type State = {
  /**
   * Set while the fullscreen backdrop is still fetching its video. The
   * audio element is held paused for as long as it is true, WITHOUT
   * touching `playing`: the store keeps the user's intent, the transport
   * still reads as playing, and audio resumes by itself the moment the
   * video has a frame. Only the fullscreen view sets this, so playback is
   * never gated on a video element that does not exist.
   */
  waiting: boolean;
  setWaiting: (waiting: boolean) => void;
};

export const useVideoGateStore = create<State>()((set) => ({
  waiting: false,
  setWaiting: (waiting) => set({ waiting }),
}));
