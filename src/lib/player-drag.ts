import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";

export type SnapZone = "right" | "bottom" | "out" | null;

/**
 * How close to a window edge (CSS pixels) the cursor has to be for
 * that edge's snap zone to trigger. Wider feels forgiving but starts
 * to overlap with "no snap" too quickly.
 */
const EDGE_THRESHOLD = 100;

/**
 * Click-vs-drag dead zone. The cover doubles as a click target in
 * other layouts (e.g. it might gain a "go to album" handler later);
 * we don't want a tiny pointer wobble on press to count as a drag.
 */
const DRAG_THRESHOLD = 6;

/**
 * Decide which snap zone the cursor is currently over, in CSS-pixel
 * client coords. Returns `"out"` when the cursor has left the window
 * entirely (we keep getting move events thanks to pointer capture).
 *
 * Right edge wins ties with bottom because the right card spans the
 * full height and its corner-overlap with the bottom bar is mostly
 * "right card territory" visually.
 */
export function detectZone(clientX: number, clientY: number): SnapZone {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (clientX < 0 || clientX > w || clientY < 0 || clientY > h) {
    return "out";
  }
  const distRight = w - clientX;
  const distBottom = h - clientY;
  if (distRight <= EDGE_THRESHOLD && distRight <= distBottom) return "right";
  if (distBottom <= EDGE_THRESHOLD) return "bottom";
  return null;
}

type DragState = {
  active: boolean;
  zone: SnapZone;
  /** Latest cursor position in CSS pixels. Drives the proximity
   *  glow on `<DragSnapOverlay>` — `null` while idle. */
  cursor: { x: number; y: number } | null;
  setActive: (v: boolean) => void;
  setZone: (z: SnapZone) => void;
  setCursor: (c: { x: number; y: number } | null) => void;
};

export const usePlayerDragStore = create<DragState>((set) => ({
  active: false,
  zone: null,
  cursor: null,
  setActive: (active) => set({ active }),
  setZone: (zone) => set({ zone }),
  setCursor: (cursor) => set({ cursor }),
}));

/**
 * Pointer-capture-based drag for the player cover. Returns
 * `onPointerDown` to attach to the cover element.
 *
 * Behavior:
 *   - left-click + move >= DRAG_THRESHOLD pixels enters drag mode
 *   - while in drag mode, the global drag store is updated so
 *     `<DragSnapOverlay>` can highlight the current zone
 *   - on pointerup:
 *       - over "right" zone     → setMode("right")
 *       - over "bottom" zone    → setMode("bottom")
 *       - cursor outside window → setMode("floating") and spawn the
 *         player window at the cursor's screen coords
 *       - anything else         → no-op (drag cancelled)
 *
 * `enabled = false` (e.g. inside the floating window itself) skips
 * everything so the OS title-bar drag isn't competed with.
 */
export function usePlayerCoverDrag({ enabled = true }: { enabled?: boolean } = {}) {
  const setMode = useLayoutStore((s) => s.setMode);
  const setActive = usePlayerDragStore((s) => s.setActive);
  const setZone = usePlayerDragStore((s) => s.setZone);
  const setCursor = usePlayerDragStore((s) => s.setCursor);

  // Refs so the inner handlers always see the latest values without
  // re-binding listeners.
  const draggingRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  // Stash the latest setter callbacks in refs so the inner handlers
  // never close over stale ones.
  const setModeRef = useRef(setMode);
  const setActiveRef = useRef(setActive);
  const setZoneRef = useRef(setZone);
  const setCursorRef = useRef(setCursor);
  setModeRef.current = setMode;
  setActiveRef.current = setActive;
  setZoneRef.current = setZone;
  setCursorRef.current = setCursor;

  // Make sure we never leave the global drag-flag stuck on if the
  // component unmounts mid-drag (e.g. user switches mode via the
  // dropdown while still holding the mouse).
  useEffect(
    () => () => {
      setActiveRef.current(false);
      setZoneRef.current(null);
      setCursorRef.current(null);
    },
    [],
  );

  // Single stable callback whose body short-circuits when disabled — keeps
  // hook-call counts identical across renders regardless of `enabled`, and
  // avoids re-attaching the prop on the cover element on every render.
  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>(
    (e) => {
      if (!enabled) return;
      // Left button only; ignore touch/pen ambiguity by also requiring
      // primary pointer.
      if (e.button !== 0) return;
      const target: HTMLElement = e.currentTarget;
      startRef.current = { x: e.clientX, y: e.clientY };
      draggingRef.current = false;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const start = startRef.current;
        if (!start) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!draggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!draggingRef.current) {
          draggingRef.current = true;
          setActiveRef.current(true);
        }
        setZoneRef.current(detectZone(ev.clientX, ev.clientY));
        setCursorRef.current({ x: ev.clientX, y: ev.clientY });
      };

      const cleanup = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onCancel);
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        setActiveRef.current(false);
        setZoneRef.current(null);
        setCursorRef.current(null);
        startRef.current = null;
        draggingRef.current = false;
      };

      const onUp = (ev: PointerEvent) => {
        const wasDragging = draggingRef.current;
        cleanup();
        if (!wasDragging) return;

        const zone = detectZone(ev.clientX, ev.clientY);
        const currentMode = useLayoutStore.getState().mode;
        if (zone === "out") {
          // Spawn the floating window roughly under the cursor. We pass
          // the cursor's *screen* coords; Rust offsets so the window's
          // titlebar lands near where the user released.
          const screenX = window.screenX + ev.clientX;
          const screenY = window.screenY + ev.clientY;
          void invoke("open_player_window", {
            x: screenX,
            y: screenY,
          }).catch((err) => {
            console.error("[player-drag] open_player_window failed:", err);
          });
          if (currentMode !== "floating") setModeRef.current("floating");
          return;
        }
        const target: LayoutMode | null =
          zone === "right" ? "right" : zone === "bottom" ? "bottom" : null;
        if (target && target !== currentMode) {
          setModeRef.current(target);
        }
      };

      const onCancel = () => cleanup();

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onCancel);
    },
    [enabled],
  );

  return { onPointerDown };
}
