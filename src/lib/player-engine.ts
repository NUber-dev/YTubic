export const PLAYER_ENGINE_QUERY_FLAG = "player-engine";

export function isPlayerEngineWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(PLAYER_ENGINE_QUERY_FLAG);
}

export type EngineCommand =
  | { type: "load"; videoId: string; autoplay: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; seconds: number }
  | { type: "setVolume"; volume: number }
  | { type: "setMuted"; muted: boolean };

export type EngineStateEvent =
  | { type: "ready" }
  | { type: "playing"; videoId: string }
  | { type: "paused"; videoId: string }
  | { type: "buffering"; videoId: string }
  | { type: "ended"; videoId: string }
  | { type: "error"; videoId: string; code: number; message: string }
  | { type: "time"; videoId: string; position: number; duration: number };
