import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { diagLog } from "@/lib/diagnostics";
import type { EngineCommand, EngineStateEvent } from "@/lib/player-engine";

type YtPlayer = {
  loadVideoById: (id: string) => void;
  cueVideoById: (id: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
};

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: {
      Player: new (
        elementId: string,
        options: {
          height: string;
          width: string;
          playerVars: Record<string, number>;
          events: {
            onReady: () => void;
            onStateChange: (e: { data: number }) => void;
            onError: (e: { data: number }) => void;
          };
        },
      ) => YtPlayer;
    };
  }
}

function describeError(code: number): string {
  switch (code) {
    case 2:
      return "invalid video id";
    case 5:
      return "playback error in the embedded player";
    case 100:
      return "video not found or removed";
    case 101:
    case 150:
      return "video owner disabled embedded playback";
    default:
      return `unknown error (${code})`;
  }
}

export default function PlayerEngineApp() {
  const playerRef = useRef<YtPlayer | null>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pendingCommandsRef = useRef<EngineCommand[]>([]);

  useEffect(() => {
    function emitState(state: EngineStateEvent) {
      void emit("engine-state", state);
    }

    function stopPolling() {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    function startPolling() {
      if (pollRef.current !== null) return;
      pollRef.current = window.setInterval(() => {
        const p = playerRef.current;
        const videoId = currentVideoIdRef.current;
        if (!p || !videoId) return;
        try {
          emitState({
            type: "time",
            videoId,
            position: p.getCurrentTime(),
            duration: p.getDuration(),
          });
        } catch {}
      }, 400);
    }

    function applyCommand(p: YtPlayer, cmd: EngineCommand) {
      diagLog("engine", `command: ${JSON.stringify(cmd)}`);
      if (cmd.type === "load") {
        currentVideoIdRef.current = cmd.videoId;
        stopPolling();
        if (cmd.autoplay) p.loadVideoById(cmd.videoId);
        else p.cueVideoById(cmd.videoId);
      } else if (cmd.type === "play") {
        p.playVideo();
      } else if (cmd.type === "pause") {
        p.pauseVideo();
      } else if (cmd.type === "seek") {
        p.seekTo(cmd.seconds, true);
      } else if (cmd.type === "setVolume") {
        p.setVolume(Math.round(cmd.volume * 100));
      } else if (cmd.type === "setMuted") {
        if (cmd.muted) p.mute();
        else p.unMute();
      }
    }

    function createPlayer() {
      if (!window.YT) return;
      playerRef.current = new window.YT.Player("yt-player-target", {
        height: "0",
        width: "0",
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            diagLog("engine", "player ready");
            emitState({ type: "ready" });
            const p = playerRef.current;
            const queued = pendingCommandsRef.current;
            pendingCommandsRef.current = [];
            if (p && queued.length) {
              diagLog("engine", `replaying ${queued.length} queued command(s)`);
              for (const cmd of queued) applyCommand(p, cmd);
            }
          },
          onStateChange: (e) => {
            const videoId = currentVideoIdRef.current;
            if (!videoId) return;
            diagLog("engine", `state ${e.data} for ${videoId}`);
            if (e.data === 1) {
              startPolling();
              emitState({ type: "playing", videoId });
            } else if (e.data === 2) {
              emitState({ type: "paused", videoId });
            } else if (e.data === 3) {
              emitState({ type: "buffering", videoId });
            } else if (e.data === 0) {
              stopPolling();
              emitState({ type: "ended", videoId });
            }
          },
          onError: (e) => {
            const videoId = currentVideoIdRef.current;
            if (!videoId) return;
            stopPolling();
            const message = describeError(e.data);
            diagLog("engine", `error for ${videoId}: ${message}`);
            emitState({ type: "error", videoId, code: e.data, message });
          },
        },
      });
    }

    if (window.YT?.Player) {
      createPlayer();
    } else {
      window.onYouTubeIframeAPIReady = createPlayer;
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }

    const unlisten = listen<EngineCommand>("engine-cmd", (event) => {
      const p = playerRef.current;
      const cmd = event.payload;
      if (!p) {
        diagLog("engine", `queueing command before player ready: ${JSON.stringify(cmd)}`);
        pendingCommandsRef.current.push(cmd);
        return;
      }
      applyCommand(p, cmd);
    });

    return () => {
      stopPolling();
      void unlisten.then((un) => un());
    };
  }, []);

  return <div id="yt-player-target" />;
}
