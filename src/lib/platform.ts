/**
 * Small synchronous platform flags for layout-only decisions.
 *
 * WKWebView identifies itself as a Mac in both `navigator.platform` and its
 * user agent. Keeping this local avoids an async native round-trip during the
 * title bar's first paint. Backend behavior still uses Rust `cfg` gates.
 */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent));
