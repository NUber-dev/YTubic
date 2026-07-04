import { Innertube, UniversalCache, ClientType } from "youtubei.js";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { resetAuthCache } from "./shared";

/**
 * Singleton InnerTube client.
 *
 * - Uses Tauri's HTTP plugin so requests go through Rust (no browser CORS).
 * - We force `Origin` and `Referer` in the fetch wrapper: tauri-plugin-http
 *   does NOT set them automatically (a normal browser would), and the
 *   innertube /player endpoint returns 403 without them.
 * - generate_session_locally: false so youtubei.js fetches a real
 *   visitor_data — otherwise YouTube's bot-check rejects requests.
 * - If the user has imported cookies via Settings, we inject them via a
 *   Cookie header so library / liked-songs endpoints work.
 */

let clientPromise: Promise<Innertube> | null = null;
let cachedCookieHeader: string = "";
let cookieHeaderLoaded = false;

async function loadCookieHeader() {
  if (cookieHeaderLoaded) return;
  cookieHeaderLoaded = true;
  try {
    cachedCookieHeader = await invoke<string>("get_cookie_header", {
      host: "music.youtube.com",
    });
  } catch {
    cachedCookieHeader = "";
  }
}

async function createClient(): Promise<Innertube> {
  await loadCookieHeader();
  return Innertube.create({
    cache: new UniversalCache(false),
    client_type: ClientType.WEB,
    generate_session_locally: false,
    fetch: (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      const origin = url.includes("music.youtube.com")
        ? "https://music.youtube.com"
        : "https://www.youtube.com";

      const headers = new Headers(init?.headers);
      if (!headers.has("Origin")) headers.set("Origin", origin);
      if (!headers.has("Referer")) headers.set("Referer", `${origin}/`);
      if (!headers.has("User-Agent")) {
        headers.set(
          "User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        );
      }
      if (cachedCookieHeader && !headers.has("Cookie")) {
        headers.set("Cookie", cachedCookieHeader);
      }

      const finalInit: RequestInit = {
        ...init,
        headers,
        cache: "no-store",
      };
      return tauriFetch(input as RequestInfo | URL, finalInit);
    },
  });
}

export function getInnertube(): Promise<Innertube> {
  if (!clientPromise) {
    clientPromise = createClient().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

/**
 * Force the next `getInnertube()` call to rebuild. Call after the user
 * logs in / out so we pick up fresh cookies. Also dumps the
 * cookie cache used by the raw POST path in `shared.ts`.
 */
export function resetInnertube() {
  clientPromise = null;
  cachedCookieHeader = "";
  cookieHeaderLoaded = false;
  resetAuthCache();
}

export async function getMusic() {
  const yt = await getInnertube();
  return yt.music;
}
