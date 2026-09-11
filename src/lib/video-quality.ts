import { diagLog } from "@/lib/diagnostics";
import { usePlaybackSettings } from "@/lib/store/playback-settings";

export type VideoQualityTier = "hi" | "lo";

let tier: VideoQualityTier | null = null;
let tierPromise: Promise<VideoQualityTier> | null = null;

async function smoothDecode(contentType: string): Promise<boolean> {
  const mc = navigator.mediaCapabilities;
  if (!mc?.decodingInfo) return false;
  try {
    const info = await mc.decodingInfo({
      type: "file",
      video: {
        contentType,
        width: 3840,
        height: 2160,
        bitrate: 15_000_000,
        framerate: 30,
      },
    });
    return info.supported && info.smooth;
  } catch {
    return false;
  }
}

async function probe(): Promise<VideoQualityTier> {
  const vp9 = await smoothDecode('video/webm; codecs="vp09.00.50.08"');
  const av1 = vp9 ? false : await smoothDecode('video/mp4; codecs="av01.0.12M.08"');
  const picked: VideoQualityTier = vp9 || av1 ? "hi" : "lo";
  diagLog(
    "video-quality",
    `capability probe: vp9=${vp9} av1=${av1} tier=${picked}`,
  );
  return picked;
}

export function getVideoQualityTier(): Promise<VideoQualityTier> {
  const choice = usePlaybackSettings.getState().videoQuality;
  if (choice !== "auto") return Promise.resolve(choice);
  if (tier) return Promise.resolve(tier);
  if (!tierPromise) {
    tierPromise = probe().then((t) => {
      tier = t;
      return t;
    });
  }
  return tierPromise;
}

export function reportPlaybackStutter(): void {
  if (usePlaybackSettings.getState().videoQuality !== "auto") return;
  if (tier === "lo") return;
  tier = "lo";
  tierPromise = Promise.resolve("lo");
  diagLog("video-quality", "dropped-frame ratio too high, downgrading to lo");
}
