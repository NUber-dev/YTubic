import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

/**
 * iTunes Search API as a hi-res cover-art fallback.
 *
 * YT Music covers max out around 1000–2000 px for newer uploads, often
 * 226×226 for older / user-curated content. iTunes ships studio art
 * straight from labels at 3000×3000+. We use it ONLY for the now-playing
 * big cover — every other UI surface keeps the YT thumbnail to avoid
 * showing a different version's art (live → studio mismatch) on cards.
 *
 * No auth, no API key, CORS open. We route through `tauri-plugin-http`
 * because the Tauri webview's `connect-src` CSP doesn't list iTunes
 * (and we don't want it to — plugin-http goes through Rust, bypassing
 * CSP entirely for the network call). The actual `<img>` then loads
 * from `*.mzstatic.com`, which IS whitelisted in `img-src`.
 *
 * Found URLs are also pinned to disk via the `cache_cover` Tauri
 * command — see `cacheCoverToDisk` below. After the first lookup the
 * webview just streams bytes from `http://127.0.0.1:<port>/cover/...`,
 * which is hot in the browser image cache and survives restarts.
 */

const CACHE_KEY_PREFIX = "ytm-cover-itunes:";
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TIMEOUT_MS = 5000;

type CacheEntry = { url: string | null; expiresAt: number };

// In-flight dedupe — multiple consumers asking for the same track
// during a single render pass should share one network request.
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(artist: string, title: string): string {
  return `${CACHE_KEY_PREFIX}${artist.toLowerCase().trim()}|${title
    .toLowerCase()
    .trim()}`;
}

function readCache(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.expiresAt < Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key: string, url: string | null): void {
  try {
    const ttl = url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    const entry: CacheEntry = { url, expiresAt: Date.now() + ttl };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full / disabled — fail silently, the lookup just
    // won't be cached for this session.
  }
}

/**
 * iTunes thumbnail URLs end with "/<W>x<H><suffix>.<ext>", e.g.
 * "/100x100bb.jpg". The CDN clamps any size request to whatever max
 * was stored (typically 3000×3000 for music), so asking for 5000 is
 * safe — we just get whatever is highest available. The "bb" suffix
 * adds the small bordered look (visually identical to none for square
 * art), and "-999" is the undocumented "highest quality, minimal
 * recompression" trick used by the iTunes Artwork Finder community.
 */
function upgradeITunesArtwork(url: string): string {
  return url.replace(
    /\/\d+x\d+[a-z-]*\.(jpg|png)$/i,
    "/100000x100000-999.$1",
  );
}

export async function lookupITunesCover(
  artist: string,
  title: string,
): Promise<string | null> {
  if (!artist.trim() || !title.trim()) return null;
  const key = cacheKey(artist, title);

  const cached = readCache(key);
  if (cached) return cached.url;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const term = encodeURIComponent(`${artist} ${title}`);
      const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
      const res = await tauriFetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Don't cache transient HTTP failures.
        return null;
      }
      const json = (await res.json()) as {
        results?: { artworkUrl100?: string }[];
      };
      const artwork100 = json.results?.[0]?.artworkUrl100;
      const result = artwork100 ? upgradeITunesArtwork(artwork100) : null;
      writeCache(key, result);
      return result;
    } catch {
      // Network error / timeout — also don't cache, let the next track
      // change retry.
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Ask the Rust side to download `url` (if it isn't on disk yet) and
 * return a `http://127.0.0.1:<port>/cover/<hash>.<ext>` URL the webview
 * can render via `<img src>`. The localhost stream server is allowed by
 * the CSP `img-src`, and the Cache-Control headers make the browser
 * keep the bytes resident for the session.
 *
 * Failures (no server yet, network down, 404 at source) fall through
 * to the original URL — the caller's `<img onError>` chain handles it.
 *
 * Two layers of dedup so a fully-rendered shelf with N cards doesn't
 * fire N concurrent invokes for the same URL:
 *   - In-memory map: once an upstream URL has been resolved this
 *     session, return the local URL synchronously.
 *   - In-flight map: if a resolve is already in progress, share the
 *     same promise.
 */
const diskCacheMemo = new Map<string, string>();
const diskCacheInflight = new Map<string, Promise<string>>();

export async function cacheCoverToDisk(url: string): Promise<string> {
  const memo = diskCacheMemo.get(url);
  if (memo) return memo;

  const pending = diskCacheInflight.get(url);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const local = await invoke<string>("cache_cover", { url });
      diskCacheMemo.set(url, local);
      return local;
    } catch (e) {
      console.warn("[cover-art] disk cache failed:", e);
      return url;
    } finally {
      diskCacheInflight.delete(url);
    }
  })();
  diskCacheInflight.set(url, promise);
  return promise;
}
