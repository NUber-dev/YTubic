import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { diagLog } from "@/lib/diagnostics";
import type { EngineCommand, EngineStateEvent } from "@/lib/player-engine";
import { usePlaybackStore } from "@/lib/store/playback";
import { usePremiumStore } from "@/lib/store/premium";
import { useSettingsStore } from "@/lib/store/settings";
import { openPremiumGate } from "@/lib/store/premium-gate";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";
import { trackKeyFor, useEngineFallbackStore } from "@/lib/store/engine-fallback";

function sendEngineCommand(cmd: EngineCommand): void {
  void emit("engine-cmd", cmd);
}

export function useAudioEngineEmbed() {
  const mode = useSettingsStore((s) => s.playbackEngine);
  const { videoId, index } = usePlaybackStore(
    useShallow((s) => {
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      return { videoId: t?.videoId, index: s.index };
    }),
  );
  const streamVideoId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
  );
  const trackKey = trackKeyFor(index, streamVideoId);
  const fallbackForTrackKey = useEngineFallbackStore((s) => s.fallbackForTrackKey);
  const usingFallback = trackKey !== null && fallbackForTrackKey === trackKey;
  const active = mode === "embed" || usingFallback;

  const engineVideoIdRef = useRef<string | null>(null);
  const consecutiveErrorsRef = useRef(0);
  const notifiedFallbackRef = useRef<string | null>(null);

  useEffect(() => {
    if (active) return;
    sendEngineCommand({ type: "pause" });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void invoke("ensure_player_engine").catch((e) => {
      diagLog("engine", `ensure_player_engine failed: ${e}`);
    });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const unlisten = listen<EngineStateEvent>("engine-state", (event) => {
      const state = event.payload;
      if (state.type === "ready") return;
      if (state.videoId !== engineVideoIdRef.current) {
        diagLog(
          "engine",
          `dropping stale ${state.type} for ${state.videoId}, current is ${engineVideoIdRef.current}`,
        );
        return;
      }

      const store = usePlaybackStore.getState;
      if (state.type === "time") {
        diagLog("engine", `time ${state.videoId} pos=${state.position} dur=${state.duration}`);
        if (Number.isFinite(state.position)) store().setPosition(state.position);
        if (Number.isFinite(state.duration) && state.duration > 0) {
          store().setDuration(state.duration);
        }
        return;
      }
      if (state.type === "playing") {
        consecutiveErrorsRef.current = 0;
        store().setStatus("ready");
        const s = store();
        const cur = s.index >= 0 ? s.queue[s.index] : undefined;
        const key = cur
          ? trackKeyFor(
              s.index,
              resolveStreamId(cur.videoId, useTrackSourceStore.getState().byVideoId),
            )
          : null;
        if (
          key &&
          useEngineFallbackStore.getState().fallbackForTrackKey === key &&
          notifiedFallbackRef.current !== key
        ) {
          notifiedFallbackRef.current = key;
          toast.info("Switched to the YouTube background player for this track");
        }
        return;
      }
      if (state.type === "ended") {
        store().next();
        return;
      }
      if (state.type === "error") {
        diagLog("engine", `error for ${state.videoId}: ${state.message}`);
        store().setStatus("error", state.message);
        const s = store();
        const hasNext = s.index >= 0 && s.index + 1 < s.queue.length;
        consecutiveErrorsRef.current += 1;
        if (s.playing && hasNext && consecutiveErrorsRef.current <= 3) {
          s.next();
        } else {
          s.setPlaying(false);
        }
      }
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, [active]);

  const premiumOk = usePremiumStore((s) => s.status === "premium");

  useEffect(() => {
    if (!active) return;
    if (!streamVideoId) {
      engineVideoIdRef.current = null;
      sendEngineCommand({ type: "pause" });
      return;
    }
    if (!premiumOk) {
      engineVideoIdRef.current = null;
      sendEngineCommand({ type: "pause" });
      const store = usePlaybackStore.getState();
      store.setStatus("idle");
      if (store.playing) {
        store.setPlaying(false);
        openPremiumGate();
      }
      return;
    }
    engineVideoIdRef.current = streamVideoId;
    usePlaybackStore.getState().setStatus("loading");
    const autoplay = usePlaybackStore.getState().playing;
    diagLog("engine", `loading ${videoId} (stream id ${streamVideoId}, autoplay=${autoplay})`);
    sendEngineCommand({ type: "load", videoId: streamVideoId, autoplay });
  }, [active, streamVideoId, videoId, index, premiumOk]);

  const playing = usePlaybackStore((s) => s.playing);
  useEffect(() => {
    if (!active) return;
    if (playing && !premiumOk) {
      usePlaybackStore.getState().setPlaying(false);
      openPremiumGate();
      return;
    }
    if (!engineVideoIdRef.current) return;
    sendEngineCommand(playing ? { type: "play" } : { type: "pause" });
  }, [active, playing, premiumOk]);

  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    if (!active) return;
    const clamped = Math.max(0, Math.min(1, volume));
    sendEngineCommand({ type: "setVolume", volume: clamped ** 3 });
    sendEngineCommand({ type: "setMuted", muted });
  }, [active, volume, muted]);

  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    if (!active) return;
    if (pendingSeek === undefined) return;
    if (engineVideoIdRef.current) {
      sendEngineCommand({ type: "seek", seconds: pendingSeek });
      if (usePlaybackStore.getState().playing) {
        sendEngineCommand({ type: "play" });
      }
    }
    usePlaybackStore.getState().clearPendingSeek();
  }, [active, pendingSeek]);
}
