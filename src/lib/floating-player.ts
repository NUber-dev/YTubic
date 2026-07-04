/** Tauri window label for the standalone floating player. */
export const FLOATING_WINDOW_LABEL = "player";

/**
 * Query-string flag the floating window is opened with. The frontend
 * branches on this in `App.tsx` to render the standalone player UI
 * instead of the full app shell.
 */
export const FLOATING_QUERY_FLAG = "floating-player";

export function isFloatingPlayerWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(FLOATING_QUERY_FLAG);
}
