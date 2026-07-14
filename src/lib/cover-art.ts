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

// v2: cache entries store the upgraded artwork URL, and v1 entries carry
// the dead "100000x100000-999" pattern (now HTTP 400). Bumping the prefix
// orphans those entries so every track re-resolves to the working
// 3000x3000bb URL (the stale v1 keys are a few KB of inert localStorage).
// v3: keys carry the album and results are album-verified, so a song
// no longer wears a different release's art (Portrait Of You showing
// the Saroor cover). Old v2 entries are orphaned.
const CACHE_KEY_PREFIX = "ytm-cover-itunes-v3:";
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TIMEOUT_MS = 5000;

type CacheEntry = { url: string | null; expiresAt: number };

// In-flight dedupe — multiple consumers asking for the same track
// during a single render pass should share one network request.
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(artist: string, title: string, album?: string): string {
  return `${CACHE_KEY_PREFIX}${artist.toLowerCase().trim()}|${title
    .toLowerCase()
    .trim()}|${(album ?? "").toLowerCase().trim()}`;
}

/** Loose text match for iTunes collection names: lowercase, strip
 *  parentheticals and punctuation. "Saroor (Original Motion...)" and
 *  "saroor" should compare equal. */
function normalizeAlbum(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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

// Hard cap on cover cache entries. Lazy TTL eviction (only on re-lookup)
// let this grow without bound — thousands of ~200-byte keys accumulate in
// the same localStorage quota that also holds the query cache and stores.
const MAX_COVER_KEYS = 500;
let writesSinceSweep = 0;

/** Drop expired/malformed cover entries and cap the total, evicting the
 *  soonest-to-expire first. Best-effort — never throws. */
function sweepCoverCache(): void {
  try {
    const live: { key: string; expiresAt: number }[] = [];
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_KEY_PREFIX)) continue;
      try {
        const e = JSON.parse(localStorage.getItem(key) ?? "") as CacheEntry;
        if (e.expiresAt < Date.now()) dead.push(key);
        else live.push({ key, expiresAt: e.expiresAt });
      } catch {
        dead.push(key);
      }
    }
    for (const key of dead) localStorage.removeItem(key);
    if (live.length > MAX_COVER_KEYS) {
      live.sort((a, b) => a.expiresAt - b.expiresAt);
      for (const e of live.slice(0, live.length - MAX_COVER_KEYS)) {
        localStorage.removeItem(e.key);
      }
    }
  } catch {
    /* best-effort */
  }
}

function writeCache(key: string, url: string | null): void {
  const ttl = url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  const entry: CacheEntry = { url, expiresAt: Date.now() + ttl };
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota exceeded (or disabled): sweep and retry once so a full cache
    // doesn't silently break persistence for everything sharing the quota.
    sweepCoverCache();
    try {
      localStorage.setItem(key, JSON.stringify(entry));
    } catch {
      /* still failing — skip caching this lookup */
    }
  }
  if (++writesSinceSweep >= 100) {
    writesSinceSweep = 0;
    sweepCoverCache();
  }
}

/**
 * iTunes thumbnail URLs end with "/<W>x<H><suffix>.<ext>", e.g.
 * "/100x100bb.jpg". The CDN clamps any size request to whatever max
 * was stored (typically 3000×3000 for music), so asking for 3000 gets
 * the highest available. The old "100000x100000-999" community trick
 * now returns HTTP 400 (Apple dropped the "-999" variant), so we ask
 * for a plain bb size the CDN still serves.
 */
function upgradeITunesArtwork(url: string): string {
  return url.replace(
    /\/\d+x\d+[a-z-]*\.(jpg|png)$/i,
    "/3000x3000bb.$1",
  );
}

export async function lookupITunesCover(
  artist: string,
  title: string,
  album?: string,
): Promise<string | null> {
  if (!artist.trim() || !title.trim()) return null;
  const key = cacheKey(artist, title, album);

  const cached = readCache(key);
  if (cached) return cached.url;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const term = encodeURIComponent(`${artist} ${title}`);
      const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=5`;
      const res = await tauriFetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Don't cache transient HTTP failures.
        return null;
      }
      const json = (await res.json()) as {
        results?: { artworkUrl100?: string; collectionName?: string }[];
      };
      const rows = json.results ?? [];
      // iTunes ranks by popularity, not by which release the song
      // belongs to, so the first hit is often a different album. When
      // the track knows its album, only a matching collection may
      // supply art; a known album with no match keeps the YT thumbnail
      // rather than wearing another release's cover. Album-less tracks
      // keep the old first-hit behavior.
      const want = album ? normalizeAlbum(album) : "";
      const hit = want
        ? rows.find((r) => {
            const got = normalizeAlbum(r.collectionName ?? "");
            return got === want || got.includes(want) || want.includes(got);
          })
        : rows[0];
      const artwork100 = hit?.artworkUrl100;
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
