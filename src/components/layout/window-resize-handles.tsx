import { getCurrentWindow } from "@tauri-apps/api/window";

// `@tauri-apps/api/window` declares `ResizeDirection` but doesn't export
// it, so we mirror the union here. Values must match the API exactly.
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/**
 * Edge + corner grips that drive native window resizing on frameless
 * windows.
 *
 * With `decorations: false`, Windows' WebView2 still exposes an
 * invisible native resize border, so the window resizes out of the box
 * there. WebKitGTK (Linux) and WKWebView (macOS) do NOT — a borderless
 * window is stuck at its size unless the page grabs the edge and calls
 * `startResizeDragging` itself. These transparent strips do exactly
 * that.
 *
 * We render them everywhere except Windows: on Windows the native
 * border already works, and overlaying our own grips there would only
 * risk fighting it. Each grip is a few pixels along one edge (or corner)
 * so it never eats clicks meant for real content.
 */
const HANDLES: { dir: ResizeDirection; className: string }[] = [
  // Edges
  { dir: "North", className: "top-0 inset-x-0 h-1.5 cursor-ns-resize" },
  { dir: "South", className: "bottom-0 inset-x-0 h-1.5 cursor-ns-resize" },
  { dir: "West", className: "left-0 inset-y-0 w-1.5 cursor-ew-resize" },
  { dir: "East", className: "right-0 inset-y-0 w-1.5 cursor-ew-resize" },
  // Corners (sit above the edges so diagonal resize wins in the corner)
  { dir: "NorthWest", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "NorthEast", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "SouthEast", className: "bottom-0 right-0 size-3 cursor-nwse-resize" },
];

// Windows' frameless windows already resize via the native invisible
// border; only the WebKit-backed platforms need JS-driven grips.
const isWindows =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export function WindowResizeHandles() {
  if (isWindows) return null;

  return (
    <>
      {HANDLES.map(({ dir, className }) => (
        <div
          key={dir}
          // Corners are 12px, edges 6px — corners come last in the DOM so
          // they paint on top and win the overlap.
          className={`absolute z-50 ${className}`}
          onMouseDown={(e) => {
            // Primary button only; let the drag-region handle moves.
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow()
              .startResizeDragging(dir)
              .catch((err) => {
                console.error("[window] startResizeDragging failed:", err);
              });
          }}
        />
      ))}
    </>
  );
}
