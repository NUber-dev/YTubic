// WKWebView's user agent always contains "Mac OS X" (even the iPad-style
// desktop UA), so a UA sniff is enough — no Tauri plugin round-trip needed.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
