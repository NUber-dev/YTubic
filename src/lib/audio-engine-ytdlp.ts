import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { prefetchStream, saveTrackMeta, streamUrlFor } from "@/lib/stream";
import { diagLog } from "@/lib/diagnostics";
import { usePlaybackStore } from "@/lib/store/playback";
import { usePremiumStore } from "@/lib/store/premium";
import { useSettingsStore } from "@/lib/store/settings";
import { openPremiumGate } from "@/lib/store/premium-gate";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";
import { trackKeyFor, useEngineFallbackStore } from "@/lib/store/engine-fallback";

export function useAudioEngineYtdlp() {
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
  const active = mode !== "embed" && !usingFallback;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resolveTokenRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
  const retriedTrackRef = useRef<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (active) return;
    audioRef.current?.pause();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (audioRef.current) return;
    const el = new Audio();
    el.preload = "auto";
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const el = audioRef.current;
    if (!el) return;
    const store = usePlaybackStore.getState;

    const onTimeUpdate = () => {
      store().setPosition(el.currentTime);
    };
    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        store().setDuration(el.duration);
      }
    };
    const onEnded = () => {
      store().next();
    };
    const onError = () => {
      const mediaErr = el.error;
      const codeLabels: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const msg = mediaErr
        ? `${codeLabels[mediaErr.code] ?? `code ${mediaErr.code}`}${
            mediaErr.message ? `: ${mediaErr.message}` : ""
          }`
        : "Unknown audio error";
      diagLog("audio", `element error: ${msg} src=${el.currentSrc || "(empty)"}`);

      const s0 = store();
      const cur0 = s0.index >= 0 ? s0.queue[s0.index] : undefined;
      const retryKey0 = cur0 ? `${cur0.videoId}:${s0.index}` : null;
      if (s0.playing && retryKey0 && retriedTrackRef.current !== retryKey0) {
        retriedTrackRef.current = retryKey0;
        store().setStatus("loading");
        window.setTimeout(() => setRetryNonce((n) => n + 1), 400);
        return;
      }

      if (useSettingsStore.getState().playbackEngine !== "embed") {
        const key = cur0
          ? trackKeyFor(
              s0.index,
              resolveStreamId(cur0.videoId, useTrackSourceStore.getState().byVideoId),
            )
          : null;
        if (key && useEngineFallbackStore.getState().fallbackForTrackKey !== key) {
          diagLog("audio", `falling back to embedded player for ${cur0?.videoId}`);
          useEngineFallbackStore.getState().setFallbackForTrackKey(key);
          return;
        }
      }

      store().setStatus("error", msg);

      const s = store();
      const hasNext = s.index >= 0 && s.index + 1 < s.queue.length;
      consecutiveErrorsRef.current += 1;
      if (s.playing && hasNext && consecutiveErrorsRef.current <= 3) {
        s.next();
      } else {
        s.setPlaying(false);
      }
    };
    const onPlaying = () => {
      consecutiveErrorsRef.current = 0;
      retriedTrackRef.current = null;
      store().setStatus("ready");
    };
    const onWaiting = () => {};

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
    };
  }, [active]);

  const premiumOk = usePremiumStore((s) => s.status === "premium");

  useEffect(() => {
    if (!active) return;
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    if (!streamVideoId) {
      el.removeAttribute("src");
      el.load();
      usePlaybackStore.getState().setStreamUrl(undefined);
      return;
    }
    if (!premiumOk) {
      el.removeAttribute("src");
      el.load();
      const store = usePlaybackStore.getState();
      store.setStreamUrl(undefined);
      store.setStatus("idle");
      if (store.playing) {
        store.setPlaying(false);
        openPremiumGate();
      }
      return;
    }
    el.removeAttribute("src");

    const token = ++resolveTokenRef.current;
    usePlaybackStore.getState().setStatus("loading");

    {
      const st = usePlaybackStore.getState();
      void saveTrackMeta(
        streamVideoId,
        st.index >= 0 ? st.queue[st.index] : undefined,
      );
    }

    diagLog("audio", `resolving stream for ${videoId} (stream id ${streamVideoId})`);
    streamUrlFor(streamVideoId)
      .then((src) => {
        if (token !== resolveTokenRef.current) {
          diagLog("audio", `stale resolve for ${videoId}, dropping src=${src}`);
          return;
        }
        diagLog("audio", `setting src for ${videoId} -> ${src}`);
        el.src = src;
        usePlaybackStore.getState().setStreamUrl(src);
        el.load();
        if (usePlaybackStore.getState().playing) {
          void el.play().catch((e) => {
            if (e?.name === "AbortError") return;
            diagLog("audio", `play() rejected for ${videoId}: ${e?.name} ${e?.message}`);
            usePlaybackStore
              .getState()
              .setStatus("error", e?.message ?? String(e));
          });
        }
      })
      .catch((e: Error) => {
        diagLog("audio", `streamUrlFor rejected for ${videoId}: ${e.message}`);
        if (token !== resolveTokenRef.current) return;
        usePlaybackStore.getState().setStatus("error", e.message);
        usePlaybackStore.getState().setPlaying(false);
      });
  }, [active, streamVideoId, videoId, index, premiumOk, retryNonce]);

  const playing = usePlaybackStore((s) => s.playing);
  useEffect(() => {
    if (!active) return;
    const el = audioRef.current;
    if (!el) return;
    if (playing && !premiumOk) {
      usePlaybackStore.getState().setPlaying(false);
      openPremiumGate();
      return;
    }
    if (!el.src) return;
    if (playing) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setStatus("error", e?.message ?? String(e));
      });
    } else {
      el.pause();
    }
  }, [active, playing, premiumOk]);

  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    if (!active) return;
    const el = audioRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(1, volume));
    el.volume = clamped ** 3;
    el.muted = muted;
  }, [active, volume, muted]);

  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    if (!active) return;
    const el = audioRef.current;
    if (!el || pendingSeek === undefined) return;
    try {
      el.currentTime = pendingSeek;
    } catch {}
    usePlaybackStore.getState().clearPendingSeek();
    if (usePlaybackStore.getState().playing && el.paused && el.src) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setStatus("error", e?.message ?? String(e));
      });
    }
  }, [active, pendingSeek]);

  const status = usePlaybackStore((s) => s.status);
  const { nextVideoId } = usePlaybackStore(
    useShallow((s) => ({
      nextVideoId:
        s.index >= 0 && s.index + 1 < s.queue.length
          ? s.queue[s.index + 1].videoId
          : undefined,
    })),
  );
  const nextStreamVideoId = useTrackSourceStore((s) =>
    nextVideoId ? resolveStreamId(nextVideoId, s.byVideoId) : undefined,
  );
  useEffect(() => {
    if (!active) return;
    if (status !== "ready") return;
    if (!nextStreamVideoId) return;
    void prefetchStream(nextStreamVideoId);
    const st = usePlaybackStore.getState();
    void saveTrackMeta(
      nextStreamVideoId,
      st.index >= 0 && st.index + 1 < st.queue.length
        ? st.queue[st.index + 1]
        : undefined,
    );
  }, [active, status, nextStreamVideoId]);
}
