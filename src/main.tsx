import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Suppress the WebView2 / Chromium native right-click menu (Back,
// Refresh, Save as, Inspect, …). Our Radix ContextMenu triggers run
// their own `preventDefault` first to open custom menus, so this
// global handler only fires for clicks on areas without a custom menu.
// DevTools stay reachable via F12 / Ctrl+Shift+I.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
