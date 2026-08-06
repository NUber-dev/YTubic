import { resetAuthCache } from "./shared";
import { resetStreamResolveSession } from "./stream-resolve";

/**
 * The browse/search/library layer is the hand-rolled raw-POST client in
 * `shared.ts`. Stream resolve uses a lazily-loaded youtubei.js session
 * (see `stream-resolve.ts`) for WEB_REMIX /player + URL decipher only —
 * dynamic import so it never lands in the initial bundle.
 *
 * `resetInnertube` is the stable name callers use after sign-in /
 * sign-out: drop the raw client's cached auth cookies and the youtubei
 * session so the next request picks up the fresh jar.
 */
export function resetInnertube() {
  resetAuthCache();
  resetStreamResolveSession();
}
