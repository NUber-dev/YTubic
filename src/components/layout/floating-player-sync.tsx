import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { usePlaybackStore } from "@/lib/store/playback";
import { useTrackSourceStore, type SourceKind } from "@/lib/store/track-source";
import type { PlaybackState } from "@/lib/store/playback";

/**
 * Cross-window playback bridge between the main window (audio engine
 * + authoritative store) and the standalone floating-player window
 * (state mirror).
 *
 *  Main side  (mounted inside `AppShell` while `mode === "floating"`):
 *    - subscribes to the playback / track-source stores and broadcasts
 *      a serializable snapshot via `playback:state` / `track-source:state`
 *    - listens for `playback:action` / `track-source:action` events
 *      (sent by the floating window's overridden store actions) and
 *      dispatches them against its local store, which then drives the
 *      audio engine and triggers the next state broadcast
 *    - re-emits the current snapshot on `playback:request-snapshot`
 *      (the floating window asks for one on mount)
 *
 *  Floating side (mounted by `FloatingPlayerApp`):
 *    - listens for the broadcast state events and merges them into its
 *      local store via `setState` (which leaves the action overrides
 *      from `playback.ts` in place)
 *    - pings `playback:request-snapshot` on mount so it doesn't have
 *      to wait for the next natural state change
 */

// "Transport" — fields that change at audio-element rate (~4 Hz from
// timeupdate). Tiny payload so emitting on every position tick is cheap.
type TransportSnapshot = Pick<
  PlaybackState,
  | "status"
  | "error"
  | "streamUrl"
  | "playing"
  | "volume"
  | "muted"
  | "playbackRate"
  | "position"
  | "duration"
>;

// "Queue" — only changes on user actions (play, skip, shuffle, etc.).
// The full queue array can be tens of KB on long playlists, so emitting
// it 4×/sec was burning serious IPC bandwidth before this split.
type QueueSnapshot = Pick<
  PlaybackState,
  "queue" | "index" | "shuffle" | "repeat" | "autoRadio"
>;

function buildTransportSnapshot(s: PlaybackState): TransportSnapshot {
  return {
    status: s.status,
    error: s.error,
    streamUrl: s.streamUrl,
    playing: s.playing,
    volume: s.volume,
    muted: s.muted,
    playbackRate: s.playbackRate,
    position: s.position,
    duration: s.duration,
  };
}

function buildQueueSnapshot(s: PlaybackState): QueueSnapshot {
  return {
    queue: s.queue,
    index: s.index,
    shuffle: s.shuffle,
    repeat: s.repeat,
    autoRadio: s.autoRadio,
  };
}

function queueChanged(prev: PlaybackState, curr: PlaybackState): boolean {
  return (
    prev.queue !== curr.queue ||
    prev.index !== curr.index ||
    prev.shuffle !== curr.shuffle ||
    prev.repeat !== curr.repeat ||
    prev.autoRadio !== curr.autoRadio
  );
}

function transportChanged(prev: PlaybackState, curr: PlaybackState): boolean {
  return (
    prev.status !== curr.status ||
    prev.error !== curr.error ||
    prev.streamUrl !== curr.streamUrl ||
    prev.playing !== curr.playing ||
    prev.volume !== curr.volume ||
    prev.muted !== curr.muted ||
    prev.playbackRate !== curr.playbackRate ||
    prev.position !== curr.position ||
    prev.duration !== curr.duration
  );
}

type PlaybackAction =
  | { type: "toggle" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; seconds: number }
  | { type: "setVolume"; volume: number }
  | { type: "toggleMute" }
  | { type: "setPlaybackRate"; rate: number }
  | { type: "setShuffle"; on: boolean }
  | { type: "cycleRepeat" }
  | { type: "goTo"; index: number }
  | { type: "removeAt"; index: number }
  | { type: "moveTrack"; from: number; to: number }
  | { type: "clearQueue" }
  | { type: "appendToQueue"; tracks: unknown[] }
  | { type: "setAutoRadio"; on: boolean }
  | { type: "playNow"; track: unknown; extras?: unknown }
  | { type: "playShelfItems"; items: unknown[]; startIndex: number }
  | { type: "enqueueNext"; track: unknown }
  | { type: "enqueueEnd"; track: unknown };

type TrackSourceAction =
  | { type: "setSelected"; id: string; selected: SourceKind }
  | { type: "setAlternate"; knownId: string; kind: SourceKind; altId: string };

export function FloatingPlayerSync() {
  // Outbound: stream state changes to the floating window. Split into
  // transport (high-freq, small payload) and queue (low-freq, large
  // payload) so position-tick updates don't drag the entire queue array
  // through IPC 4 times a second.
  useEffect(() => {
    const unsubP = usePlaybackStore.subscribe((curr, prev) => {
      if (transportChanged(prev, curr)) {
        void emit("playback:transport", buildTransportSnapshot(curr));
      }
      if (queueChanged(prev, curr)) {
        void emit("playback:queue", buildQueueSnapshot(curr));
      }
    });
    const unsubT = useTrackSourceStore.subscribe((s) => {
      void emit("track-source:state", { byVideoId: s.byVideoId });
    });
    // Initial broadcast — covers the case where the floating window
    // already exists when this sender mounts.
    const initial = usePlaybackStore.getState();
    void emit("playback:transport", buildTransportSnapshot(initial));
    void emit("playback:queue", buildQueueSnapshot(initial));
    void emit("track-source:state", {
      byVideoId: useTrackSourceStore.getState().byVideoId,
    });
    return () => {
      unsubP();
      unsubT();
    };
  }, []);

  // Inbound: dispatch action events from the floating window against
  // the authoritative local store. The store update will propagate
  // back to the floater via the outbound subscription above.
  //
  // The `cancelled` flag handles React StrictMode's mount → unmount →
  // remount dance: each `listen()` is async, so the cleanup may run
  // before the promise resolves. Without this, the resolved `un`
  // would leak (stored in a closure for an effect that's already torn
  // down) and we'd end up with TWO active listeners — which made
  // every dispatched `toggle` flip `playing` twice, silently no-op'ing
  // play/pause from the floating window. (Actions like `next`/`prev`
  // set explicit values, so a double-dispatch happened to be idempotent
  // for them — only state-flippers were visibly broken.)
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    const register = (p: Promise<() => void>) => {
      void p.then((un) => {
        if (cancelled) un();
        else unlistens.push(un);
      });
    };

    register(
      listen<PlaybackAction>("playback:action", (e) => {
        const a = e.payload;
        const store = usePlaybackStore.getState();
        switch (a.type) {
          case "toggle":
            store.toggle();
            break;
          case "next":
            store.next();
            break;
          case "prev":
            store.prev();
            break;
          case "seek":
            store.seek(a.seconds);
            break;
          case "setVolume":
            store.setVolume(a.volume);
            break;
          case "toggleMute":
            store.toggleMute();
            break;
          case "setPlaybackRate":
            // Rate is validated inside the store (PLAYBACK_RATES allow-list).
            store.setPlaybackRate(a.rate as never);
            break;
          case "setShuffle":
            store.setShuffle(a.on);
            break;
          case "cycleRepeat":
            store.cycleRepeat();
            break;
          case "goTo":
            store.goTo(a.index);
            break;
          case "removeAt":
            store.removeAt(a.index);
            break;
          case "moveTrack":
            store.moveTrack(a.from, a.to);
            break;
          case "clearQueue":
            store.clearQueue();
            break;
          case "appendToQueue":
            // Tracks arrive as serialized QueueTrack-shaped objects;
            // the store's `appendToQueue` accepts both QueueTrack and
            // ShelfItem and pulls just the fields it needs.
            store.appendToQueue(a.tracks as never);
            break;
          case "setAutoRadio":
            store.setAutoRadio(a.on);
            break;
          // Serialized ShelfItem/QueueTrack objects; the store methods
          // accept both shapes and pull only the fields they need.
          case "playNow":
            store.playNow(a.track as never, a.extras as never);
            break;
          case "playShelfItems":
            store.playShelfItems(a.items as never, a.startIndex);
            break;
          case "enqueueNext":
            store.enqueueNext(a.track as never);
            break;
          case "enqueueEnd":
            store.enqueueEnd(a.track as never);
            break;
        }
      }),
    );

    register(
      listen<TrackSourceAction>("track-source:action", (e) => {
        const a = e.payload;
        const store = useTrackSourceStore.getState();
        switch (a.type) {
          case "setSelected":
            store.setSelected(a.id, a.selected);
            break;
          case "setAlternate":
            store.setAlternate(a.knownId, a.kind, a.altId);
            break;
        }
      }),
    );

    register(
      listen("playback:request-snapshot", () => {
        const s = usePlaybackStore.getState();
        void emit("playback:transport", buildTransportSnapshot(s));
        void emit("playback:queue", buildQueueSnapshot(s));
        void emit("track-source:state", {
          byVideoId: useTrackSourceStore.getState().byVideoId,
        });
      }),
    );

    return () => {
      cancelled = true;
      for (const un of unlistens) un();
    };
  }, []);

  return null;
}

export function FloatingPlayerSyncReceiver() {
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const register = (p: Promise<() => void>) => {
      void p.then((un) => {
        if (cancelled) un();
        else unlistens.push(un);
      });
    };

    register(
      listen<TransportSnapshot>("playback:transport", (e) => {
        // Merge — preserves the action overrides installed by
        // `playback.ts` for the floating window.
        usePlaybackStore.setState(e.payload);
      }),
    );

    register(
      listen<QueueSnapshot>("playback:queue", (e) => {
        usePlaybackStore.setState(e.payload);
      }),
    );

    register(
      listen<{ byVideoId: Record<string, unknown> }>(
        "track-source:state",
        (e) => {
          useTrackSourceStore.setState({
            byVideoId: e.payload.byVideoId as never,
          });
        },
      ),
    );

    // Ask the main window for the latest snapshot — covers the case
    // where the floater opened after the relevant state already
    // happened in the main window (e.g. user already had a track
    // playing when they switched to floating mode).
    void emit("playback:request-snapshot", {});

    return () => {
      cancelled = true;
      for (const un of unlistens) un();
    };
  }, []);

  return null;
}
