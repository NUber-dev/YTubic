import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { usePlaybackStore } from "@/lib/store/playback";
import { useTrackSourceStore, type SourceKind } from "@/lib/store/track-source";
import { detectZone, usePlayerDragStore } from "@/lib/player-drag";
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
  | "streamMethod"
  | "playing"
  | "volume"
  | "muted"
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
    streamMethod: s.streamMethod,
    playing: s.playing,
    volume: s.volume,
    muted: s.muted,
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
    prev.streamMethod !== curr.streamMethod ||
    prev.playing !== curr.playing ||
    prev.volume !== curr.volume ||
    prev.muted !== curr.muted ||
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

  // While the user is dragging the floating window via its OS title
  // bar, mirror its virtual-cursor stream into the same drag store
  // that the in-window cover drag uses. The existing
  // `<DragSnapOverlay>` then lights up the right/bottom snap zones
  // in real time as the floating window approaches them, giving
  // consistent visual feedback for both kinds of drag.
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
      listen<{ x: number; y: number }>("drag:floating-position", (e) => {
        const { x, y } = e.payload;
        const drag = usePlayerDragStore.getState();
        if (!drag.active) drag.setActive(true);
        drag.setCursor({ x, y });
        drag.setZone(detectZone(x, y));
      }),
    );

    register(
      listen("drag:floating-end", () => {
        const drag = usePlayerDragStore.getState();
        drag.setActive(false);
        drag.setZone(null);
        drag.setCursor(null);
      }),
    );

    return () => {
      cancelled = true;
      for (const un of unlistens) un();
      // Defensive: if the watcher is unmounting mid-drag (e.g. the
      // user closed the floating window), reset the overlay so it
      // doesn't get stuck visible on the main window.
      const drag = usePlayerDragStore.getState();
      if (drag.active) {
        drag.setActive(false);
        drag.setZone(null);
        drag.setCursor(null);
      }
    };
  }, []);

  return null;
}

/**
 * Floating-window-side: when the user drags the standalone window
 * back over the main window, auto-close it so the layout reverts to
 * "right" mode (handled by `app-shell.tsx`'s `player-window-closed`
 * listener).
 *
 * Implemented as a debounced poll on `onMoved`: while the OS drag is
 * happening events fire continuously; we only act ~300 ms after the
 * last event so brief crossings don't accidentally dock.
 *
 * "Inside" = the floating window's center point falls within the
 * main window's outer rectangle. Coords come back in physical pixels
 * but both windows report in the same unit, so no DPR conversion is
 * needed for the comparison.
 */
function FloatingDockWatcher() {
  useEffect(() => {
    const me = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /**
     * Compute the floating window's center expressed in the main
     * window's local CSS-pixel coordinate space. That doubles as the
     * "virtual cursor" position the main side uses to drive its
     * `DragSnapOverlay` — so users get the same red snap-zone glow
     * whether they're dragging the cover thumbnail or the whole
     * floating window.
     */
    const computeVirtualCursor = async () => {
      try {
        const myPos = await me.outerPosition();
        const mySize = await me.outerSize();
        const main = await Window.getByLabel("main");
        if (!main) return null;
        // Don't dock against a main window that's hidden to the tray — its
        // outerPosition/outerSize still report the last on-screen rect, so
        // dragging the floater over that empty area would wrongly close it
        // and leave audio playing with no visible player.
        if (!(await main.isVisible())) return null;
        const mainPos = await main.outerPosition();
        const mainSize = await main.outerSize();
        // Coords come back in physical pixels; main's `window.innerWidth`
        // (which `detectZone` reads) is logical, so we divide through
        // by the main window's scale factor.
        const factor = await main.scaleFactor();

        const cx = myPos.x + mySize.width / 2;
        const cy = myPos.y + mySize.height / 2;
        const localX = (cx - mainPos.x) / factor;
        const localY = (cy - mainPos.y) / factor;
        const mainW = mainSize.width / factor;
        const mainH = mainSize.height / factor;
        const inside =
          localX >= 0 && localX <= mainW && localY >= 0 && localY <= mainH;

        return { x: localX, y: localY, inside };
      } catch (e) {
        console.error("[floating] cursor compute failed:", e);
        return null;
      }
    };

    const checkDock = async () => {
      const v = await computeVirtualCursor();
      if (v?.inside) {
        await invoke("close_player_window").catch(() => {
          /* fine — could already be closed */
        });
      }
    };

    void me
      .onMoved(async () => {
        const v = await computeVirtualCursor();
        if (v) {
          // Stream the virtual cursor to the main window so its
          // `DragSnapOverlay` can light up the snap zones in real
          // time. We send raw coords (not the zone) — main runs
          // `detectZone` itself against its own `window.innerWidth`.
          void emit("drag:floating-position", { x: v.x, y: v.y });
        }

        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(async () => {
          // 300 ms with no further movement counts as "drop". Run the
          // dock check first (might close the window, which makes the
          // end-event ride along to a zombie listener — harmless),
          // then tell main to clear the overlay.
          await checkDock();
          void emit("drag:floating-end", {});
        }, 300);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      unlisten?.();
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

  return <FloatingDockWatcher />;
}
