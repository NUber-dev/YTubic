import { create } from "zustand";

type State = {
  /** Seconds the user is currently dragging the progress slider to, or
   *  `null` when nobody is dragging. */
  scrub: number | null;
  setScrub: (v: number | null) => void;
};

/**
 * Live progress-slider drag target, shared across the player bar and the
 * lyrics panel.
 *
 * The actual seek only lands on pointer release (`onValueCommit`), so
 * during the drag the playback store's `position` still tracks the audio
 * element. Anything that wants to preview where the thumb is pointing
 * (the timestamp label, the timed lyrics) reads this instead, which is
 * why it can't stay local state inside the bar.
 *
 * Not persisted: a drag never survives a reload.
 */
export const useScrubStore = create<State>()((set) => ({
  scrub: null,
  setScrub: (scrub) => set({ scrub }),
}));
