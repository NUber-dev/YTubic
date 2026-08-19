import { useAudioEngineShared } from "@/lib/audio-engine-shared";
import { useAudioEngineEmbed } from "@/lib/audio-engine-embed";
import { useAudioEngineYtdlp } from "@/lib/audio-engine-ytdlp";

export function useAudioEngine() {
  useAudioEngineShared();
  useAudioEngineEmbed();
  useAudioEngineYtdlp();
}
