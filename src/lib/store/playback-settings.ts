import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeLocalStorage } from "./safe-storage";

export type EqPreset = "flat" | "bass" | "vocal" | "treble" | "late" | "custom";

export type BackButtonMode = "previous" | "restart" | "smart";

export type VideoQualityChoice = "auto" | "hi" | "lo";

/** Centre frequencies of the nine bands, in Hz. */
export const EQ_BANDS = [62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** How far a band can be pushed either way, in dB. */
export const EQ_RANGE = 12;

/** The preset curves, straight from the design handoff. */
export const EQ_PRESETS: Record<Exclude<EqPreset, "custom">, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [10, 8, 5, 2, 0, -1, -1, 0, 0],
  vocal: [-3, -1, 2, 5, 6, 4, 2, 0, -1],
  treble: [-2, -1, 0, 1, 2, 4, 7, 9, 10],
  late: [5, 4, 2, 0, -1, -2, -3, -4, -6],
};

type State = {
  /** Seconds of overlap between tracks. 0 = off. */
  crossfadeSec: number;
  /** Even out loudness between tracks. */
  normalizeVolume: boolean;
  eqEnabled: boolean;
  eqPreset: EqPreset;
  /** The nine band gains in dB, only meaningful while `eqPreset` is "custom". */
  eqCustomGains: number[];
  monoAudio: boolean;
  /** `MediaDeviceInfo.deviceId`, or "" for the system default. */
  outputDeviceId: string;
  /** What Previous does part-way into a track. */
  backButton: BackButtonMode;
  /** With "smart": play past this many seconds and Previous restarts
   *  the track instead of stepping back. */
  smartBackSeconds: number;
  /** Come back to the track and position that were playing at exit.
   *  The queue and track already survive a restart; the position does
   *  not, and this is the switch for it. */
  resumePlayback: boolean;
  /** Ceiling for the music-video backdrop. "auto" probes what the GPU can
   *  decode smoothly and steps down if frames start dropping; an explicit
   *  choice is left alone. */
  videoQuality: VideoQualityChoice;
  /** Carry a switch to Video onto the tracks that follow it. Each new
   *  track costs a search and a round of yt-dlp verification. */
  followVideoMode: boolean;
  /** Fetch the next track's video while the current one plays. Removes
   *  the wait at the cost of a whole video file per track. */
  warmNextVideo: boolean;
  /** Jump past the intros, outros and talking in a music video, using
   *  SponsorBlock's music_offtopic segments. Off by default: it queries a
   *  third party, albeit only with a hash prefix of the video id. */
  skipNonMusic: boolean;
  setCrossfadeSec: (v: number) => void;
  setNormalizeVolume: (v: boolean) => void;
  setEqEnabled: (v: boolean) => void;
  setEqPreset: (v: EqPreset) => void;
  setBandGain: (index: number, gain: number) => void;
  setMonoAudio: (v: boolean) => void;
  setOutputDeviceId: (v: string) => void;
  setBackButton: (v: BackButtonMode) => void;
  setSmartBackSeconds: (v: number) => void;
  setResumePlayback: (v: boolean) => void;
  setVideoQuality: (v: VideoQualityChoice) => void;
  setFollowVideoMode: (v: boolean) => void;
  setWarmNextVideo: (v: boolean) => void;
  setSkipNonMusic: (v: boolean) => void;
};

/** The gains currently in force, whichever way they were chosen. */
export function eqGains(state: {
  eqPreset: EqPreset;
  eqCustomGains: number[];
}): number[] {
  return state.eqPreset === "custom"
    ? state.eqCustomGains
    : EQ_PRESETS[state.eqPreset];
}

/**
 * The Playback tab's settings.
 *
 * Read by the audio engine (`src/lib/audio-engine.ts`): crossfade runs on
 * its second element, the equaliser, mono and normalisation live in the
 * WebAudio graph (`src/lib/audio-graph.ts`), the output device goes to
 * `setSinkId`, and the Previous rule is applied in `prev()` of the
 * playback store. `resumePlayback` decides whether the store keeps the
 * persisted position on launch.
 */
export const usePlaybackSettings = create<State>()(
  persist(
    (set) => ({
      crossfadeSec: 0,
      normalizeVolume: false,
      eqEnabled: false,
      eqPreset: "flat",
      eqCustomGains: [...EQ_PRESETS.flat],
      monoAudio: false,
      outputDeviceId: "",
      backButton: "smart",
      smartBackSeconds: 3,
      resumePlayback: true,
      videoQuality: "auto",
      followVideoMode: true,
      warmNextVideo: true,
      skipNonMusic: false,
      setCrossfadeSec: (crossfadeSec) =>
        set({
          crossfadeSec: Math.min(12, Math.max(0, Math.round(crossfadeSec))),
        }),
      setNormalizeVolume: (normalizeVolume) => set({ normalizeVolume }),
      setEqEnabled: (eqEnabled) => set({ eqEnabled }),
      setEqPreset: (eqPreset) => set({ eqPreset }),
      // Dragging a band is what turns a preset into a custom curve: the
      // preset's own numbers become the starting point rather than being
      // overwritten in place.
      setBandGain: (index, gain) =>
        set((s) => {
          const base = eqGains(s);
          const next = [...base];
          next[index] = Math.min(EQ_RANGE, Math.max(-EQ_RANGE, gain));
          return { eqPreset: "custom", eqCustomGains: next };
        }),
      setMonoAudio: (monoAudio) => set({ monoAudio }),
      setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
      setBackButton: (backButton) => set({ backButton }),
      setSmartBackSeconds: (smartBackSeconds) => set({ smartBackSeconds }),
      setResumePlayback: (resumePlayback) => set({ resumePlayback }),
      setVideoQuality: (videoQuality) => set({ videoQuality }),
      setFollowVideoMode: (followVideoMode) => set({ followVideoMode }),
      setWarmNextVideo: (warmNextVideo) => set({ warmNextVideo }),
      setSkipNonMusic: (skipNonMusic) => set({ skipNonMusic }),
    }),
    {
      name: "ytm-playback-settings",
      storage: createJSONStorage(() => safeLocalStorage),
    },
  ),
);
