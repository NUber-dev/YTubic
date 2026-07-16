import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import {
  authHeaders,
  captureSetCookies,
  DESKTOP_UA,
  innertubePost,
  type YtNode,
} from "./shared";

/**
 * WEB_REMIX-only stream resolve — same session as browse (cookies +
 * SAPISIDHASH). No ANDROID_VR / MWEB / yt-dlp paths here.
 *
 * Order:
 *  1. Raw Music `/player` via `innertubePost` (same auth as Liked songs).
 *  2. youtubei.js music.getInfo / getBasicInfo for decipher fallback.
 *
 * URLs are Range-probed before register so a 403 never reaches Rust.
 */

export type ResolvedWebStream = {
  videoId: string;
  url: string;
  mimeType: string;
  isWebm: boolean;
  itag?: number;
  client: string;
  /** Must match the client that signed the googlevideo URL. */
  userAgent: string;
};

type AuthContext = { cookie: string; pageId: string | null };

const VISITOR_DATA_STORAGE_KEY = "ytm-visitor-data";

let innertubePromise: Promise<unknown> | null = null;
let innertubeCookie = "";
let evalInstalled = false;

/** Drop the cached youtubei session (call on sign-in / sign-out). */
export function resetStreamResolveSession(): void {
  innertubePromise = null;
  innertubeCookie = "";
}

function loadVisitorData(): string | null {
  try {
    return window.localStorage.getItem(VISITOR_DATA_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function logResolve(line: string): Promise<void> {
  console.info(line);
  try {
    await invoke("log_stream_line", { line });
  } catch {
    /* ignore */
  }
}

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "youtube.com" ||
    h.endsWith(".youtube.com") ||
    h === "google.com" ||
    h.endsWith(".google.com") ||
    h === "googleapis.com" ||
    h.endsWith(".googleapis.com") ||
    h === "googlevideo.com" ||
    h.endsWith(".googlevideo.com") ||
    h === "ggpht.com" ||
    h.endsWith(".ggpht.com") ||
    h === "ytimg.com" ||
    h.endsWith(".ytimg.com") ||
    h === "googleusercontent.com" ||
    h.endsWith(".googleusercontent.com") ||
    h === "gstatic.com" ||
    h.endsWith(".gstatic.com")
  );
}

function extractSapisid(cookie: string): string | undefined {
  return (
    cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1] ??
    cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1]
  );
}

async function sha1Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Cookie + SAPISIDHASH for a given request origin. youtubei.js only
 * looks up plain `SAPISID` (and its cookie regex is broken on `; `
 * separators), so we always inject this ourselves.
 */
async function sapisidHashHeaders(
  origin: string,
): Promise<Record<string, string>> {
  const auth = await authHeaders();
  const cookie = auth.Cookie ?? auth.cookie;
  if (!cookie) return {};

  const out: Record<string, string> = { Cookie: cookie };
  if (auth["X-Goog-PageId"]) out["X-Goog-PageId"] = auth["X-Goog-PageId"];

  const sapisid = extractSapisid(cookie);
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${sapisid} ${origin}`);
    out.Authorization = `SAPISIDHASH ${ts}_${hash}`;
  }
  return out;
}

/**
 * Route youtubei.js network through Tauri HTTP + live cookie jar, and
 * force SAPISIDHASH / Origin the way official YTM does.
 */
function makeTauriFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    let hostname = "";
    let origin = "";
    try {
      const u = new URL(url);
      hostname = u.hostname;
      origin = u.origin;
    } catch {
      /* ignore */
    }

    const headers = new Headers(init?.headers ?? req?.headers);
    if (hostAllowed(hostname)) {
      const authOrigin = hostname.includes("music.youtube.com")
        ? "https://music.youtube.com"
        : origin.startsWith("http")
          ? origin
          : "https://www.youtube.com";
      const auth = await sapisidHashHeaders(authOrigin);
      for (const [k, v] of Object.entries(auth)) {
        headers.set(k, v);
      }
      if (!headers.has("origin")) headers.set("Origin", authOrigin);
      if (!headers.has("referer")) headers.set("Referer", `${authOrigin}/`);
    }
    if (!headers.has("user-agent")) {
      headers.set("user-agent", DESKTOP_UA);
    }

    const headerObj: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerObj[key] = value;
    });

    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();

    let rawBody: BodyInit | null | undefined = init?.body;
    if (rawBody == null && req && method !== "GET" && method !== "HEAD") {
      try {
        rawBody = await req.clone().arrayBuffer();
      } catch {
        rawBody = undefined;
      }
    }

    let tauriBody: BodyInit | undefined;
    if (rawBody == null) {
      tauriBody = undefined;
    } else if (typeof rawBody === "string" || rawBody instanceof ArrayBuffer) {
      tauriBody = rawBody as BodyInit;
    } else if (rawBody instanceof Uint8Array) {
      tauriBody = rawBody as unknown as BodyInit;
    } else if (rawBody instanceof URLSearchParams) {
      tauriBody = rawBody.toString();
    } else if (typeof Blob !== "undefined" && rawBody instanceof Blob) {
      tauriBody = await rawBody.arrayBuffer();
    } else {
      return fetch(input, init);
    }

    try {
      const res = await tauriFetch(url, {
        method,
        headers: headerObj,
        body: tauriBody as never,
      });
      await captureSetCookies(res);
      return res;
    } catch (e) {
      console.info("[stream-resolve] tauriFetch failed", method, url, e);
      throw e;
    }
  };
}

async function getCookie(): Promise<string> {
  try {
    const ctx = await invoke<AuthContext>("get_auth_context", {
      host: "music.youtube.com",
    });
    return ctx.cookie ?? "";
  } catch {
    return "";
  }
}

/**
 * Load youtubei.js. Prefer the pre-bundled browser build (avoids Vite
 * re-graphing the ESM graph that TDZ'd the named `Innertube` export).
 * Always take the default export — named interop was the failure mode
 * in production (`Cannot access 'Innertube' before initialization`).
 */
async function loadYoutubeiModule(): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Innertube: { create: (opts: Record<string, unknown>) => Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Platform: { shim: { eval: (...args: any[]) => any } };
}> {
  // Try pre-bundled first; fall back to /web ESM entry.
  let mod: Record<string, unknown>;
  try {
    mod = (await import("youtubei.js/web.bundle")) as Record<string, unknown>;
  } catch {
    mod = (await import("youtubei.js/web")) as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Innertube: any = mod.default ?? mod.Innertube;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Platform: any = mod.Platform;
  if (typeof Innertube?.create !== "function") {
    throw new Error(
      `youtubei module has no Innertube.create (keys=${Object.keys(mod).slice(0, 12).join(",")})`,
    );
  }
  if (!Platform?.shim) {
    throw new Error("youtubei module has no Platform.shim");
  }
  return { Innertube, Platform };
}

async function getInnertube(): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yt: any;
  cookie: string;
}> {
  const cookie = await getCookie();
  if (innertubePromise && innertubeCookie === cookie) {
    const yt = await innertubePromise;
    return { yt, cookie };
  }

  innertubeCookie = cookie;
  innertubePromise = (async () => {
    const { Innertube, Platform } = await loadYoutubeiModule();

    if (!evalInstalled) {
      // youtubei 17: eval(data, env) → { sig?, n? }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Platform.shim.eval = async (data: any) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        return new Function(data.output)();
      };
      evalInstalled = true;
    }

    const visitor = loadVisitorData() ?? undefined;
    return Innertube.create({
      cookie: cookie || undefined,
      visitor_data: visitor,
      fetch: makeTauriFetch() as typeof fetch,
      generate_session_locally: true,
      retrieve_player: true,
    });
  })().catch((e) => {
    innertubePromise = null;
    throw e;
  });

  const yt = await innertubePromise;
  return { yt, cookie };
}

type AudioFormat = {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  cipher?: string;
  mimeType?: string;
  bitrate?: number;
};

function pickBestAudio(formats: AudioFormat[]): AudioFormat | null {
  const audio = formats.filter(
    (f) => typeof f.mimeType === "string" && f.mimeType.startsWith("audio/"),
  );
  if (audio.length === 0) return null;
  // Prefer plain-URL formats (no decipher needed), then webm, then bitrate.
  const score = (f: AudioFormat) => {
    const plain = typeof f.url === "string" && f.url.length > 0 ? 2_000_000_000 : 0;
    const webm = f.mimeType?.includes("webm") ? 1_000_000_000 : 0;
    return plain + webm + (f.bitrate ?? 0);
  };
  audio.sort((a, b) => score(b) - score(a));
  return audio[0] ?? null;
}

/**
 * Raw Music `/player` with the same SAPISIDHASH jar as browse. Formats
 * are usually signatureCipher'd — use only when we get a plain URL or
 * when youtubei can decipher.
 */
async function resolveViaRawPlayer(
  videoId: string,
): Promise<ResolvedWebStream | null> {
  const t0 = performance.now();
  let signatureTimestamp: number | undefined;
  try {
    const { yt } = await getInnertube();
    const sts = yt?.session?.player?.signature_timestamp;
    if (typeof sts === "number" && sts > 0) signatureTimestamp = sts;
  } catch {
    /* player not ready — still try /player */
  }

  const body: Record<string, unknown> = {
    videoId,
    racyCheckOk: true,
    contentCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        lactMilliseconds: "-1",
        ...(signatureTimestamp != null ? { signatureTimestamp } : {}),
      },
    },
  };

  let data: YtNode;
  try {
    data = await innertubePost("player", body);
  } catch (e) {
    await logResolve(
      `[stream] ${videoId}: raw player error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }

  const status = data?.playabilityStatus?.status as string | undefined;
  if (status && status !== "OK") {
    await logResolve(
      `[stream] ${videoId}: raw player playability ${status}: ${
        data?.playabilityStatus?.reason ?? ""
      }`,
    );
    return null;
  }

  const adaptive = (data?.streamingData?.adaptiveFormats ??
    []) as AudioFormat[];
  const progressive = (data?.streamingData?.formats ?? []) as AudioFormat[];
  const format = pickBestAudio([...adaptive, ...progressive]);
  if (!format) {
    await logResolve(
      `[stream] ${videoId}: raw player no audio formats (adaptive=${adaptive.length})`,
    );
    return null;
  }

  let url = typeof format.url === "string" ? format.url : undefined;
  if (!url && (format.signatureCipher || format.cipher)) {
    try {
      const { yt } = await getInnertube();
      const player = yt?.session?.player;
      if (player && typeof player.decipher === "function") {
        url = await player.decipher(
          format.url,
          format.signatureCipher,
          format.cipher,
        );
      } else {
        await logResolve(
          `[stream] ${videoId}: raw player no player.decipher (session ready=${!!yt?.session})`,
        );
      }
    } catch (e) {
      await logResolve(
        `[stream] ${videoId}: raw player decipher failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  if (!url || typeof url !== "string") {
    await logResolve(
      `[stream] ${videoId}: raw player no URL (itag=${format.itag ?? "?"})`,
    );
    return null;
  }

  // youtubei leaves a poisoned `n` when nsig extraction fails — GV then 403s.
  try {
    const n = new URL(url).searchParams.get("n") ?? "";
    if (n.startsWith("enhanced_except_") || n.includes("exception")) {
      await logResolve(
        `[stream] ${videoId}: raw player nsig failed (n=${n.slice(0, 40)})`,
      );
      return null;
    }
  } catch {
    /* ignore URL parse */
  }

  const mimeType = format.mimeType ?? "audio/webm";
  const isWebm = mimeType.includes("webm");
  await logResolve(
    `[stream] ${videoId}: web_remix raw_player ok itag=${format.itag ?? "?"} ${mimeType} ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );

  return {
    videoId,
    url,
    mimeType,
    isWebm,
    itag: format.itag,
    client: "WEB_REMIX/raw_player",
    userAgent: DESKTOP_UA,
  };
}

/** Fallback: full youtubei music.getInfo (with fixed SAPISIDHASH fetch). */
async function resolveViaYoutubei(
  videoId: string,
): Promise<ResolvedWebStream | null> {
  const t0 = performance.now();
  let yt: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any;
  try {
    ({ yt } = await getInnertube());
  } catch (e) {
    await logResolve(
      `[stream] ${videoId}: youtubei session failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let info: any;
  let client = "WEB_REMIX/music";
  try {
    info = await yt.music.getInfo(videoId);
    if (!info?.streaming_data?.adaptive_formats?.length) {
      throw new Error("music info has no adaptive formats");
    }
  } catch (musicErr) {
    await logResolve(
      `[stream] ${videoId}: youtubei music.getInfo failed: ${
        (musicErr as Error)?.message ?? musicErr
      }`,
    );
    try {
      info = await yt.getBasicInfo(videoId);
      client = "WEB";
    } catch (webErr) {
      await logResolve(
        `[stream] ${videoId}: youtubei getBasicInfo failed: ${
          (webErr as Error)?.message ?? webErr
        }`,
      );
      return null;
    }
  }

  const status = info?.playability_status?.status;
  if (status && status !== "OK") {
    await logResolve(
      `[stream] ${videoId}: youtubei playability ${status}: ${
        info?.playability_status?.reason ?? ""
      }`,
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let format: any;
  try {
    format = info.chooseFormat({
      type: "audio",
      quality: "best",
      format: "webm",
    });
  } catch {
    try {
      format = info.chooseFormat({ type: "audio", quality: "best" });
    } catch (fmtErr) {
      await logResolve(
        `[stream] ${videoId}: youtubei chooseFormat failed: ${
          (fmtErr as Error)?.message ?? fmtErr
        }`,
      );
      return null;
    }
  }

  let url: string | undefined;
  if (typeof format.decipher === "function" && yt.session?.player) {
    try {
      const deciphered = format.decipher(yt.session.player);
      url = deciphered instanceof Promise ? await deciphered : deciphered;
    } catch (decErr) {
      await logResolve(
        `[stream] ${videoId}: youtubei decipher failed: ${
          (decErr as Error)?.message ?? decErr
        }`,
      );
    }
  }
  if (!url || typeof url !== "string") {
    url = typeof format.url === "string" ? format.url : undefined;
  }
  if (!url || typeof url !== "string") {
    await logResolve(
      `[stream] ${videoId}: youtubei no URL after decipher itag=${format?.itag ?? "?"}`,
    );
    return null;
  }

  const mimeType: string = format.mime_type ?? format.mimeType ?? "audio/webm";
  const isWebm = mimeType.includes("webm");
  await logResolve(
    `[stream] ${videoId}: web_remix ${client} ok itag=${format.itag ?? "?"} ${mimeType} ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );

  return {
    videoId,
    url,
    mimeType,
    isWebm,
    itag: format.itag,
    client,
    userAgent: DESKTOP_UA,
  };
}

/**
 * Range-probe a googlevideo URL with the same header strategies Rust
 * uses for download. Rejects 403s so we never register a bad URL.
 */
async function probeStreamUrl(
  videoId: string,
  resolved: ResolvedWebStream,
): Promise<boolean> {
  let cookie = "";
  try {
    const auth = await sapisidHashHeaders("https://music.youtube.com");
    cookie = auth.Cookie ?? "";
  } catch {
    /* ignore */
  }

  type Strat = { name: string; origin?: string; cookie?: string };
  const strats: Strat[] = [
    { name: "music+cookie", origin: "https://music.youtube.com", cookie },
    { name: "www+cookie", origin: "https://www.youtube.com", cookie },
    { name: "music", origin: "https://music.youtube.com" },
    { name: "ua-only" },
  ];

  for (const s of strats) {
    if (s.cookie !== undefined && !s.cookie) continue;
    const headers: Record<string, string> = {
      "User-Agent": resolved.userAgent,
      Accept: "*/*",
      Range: "bytes=0-2047",
    };
    if (s.origin) {
      headers.Origin = s.origin;
      headers.Referer = `${s.origin}/`;
    }
    if (s.cookie) headers.Cookie = s.cookie;
    try {
      const res = await tauriFetch(resolved.url, { method: "GET", headers });
      if (res.status === 200 || res.status === 206) {
        await logResolve(
          `[stream] ${videoId}: probe ok ${resolved.client}/${s.name} http ${res.status}`,
        );
        return true;
      }
      if (res.status !== 403) {
        await logResolve(
          `[stream] ${videoId}: probe fail ${resolved.client} http ${res.status}`,
        );
        return false;
      }
    } catch (e) {
      await logResolve(
        `[stream] ${videoId}: probe error ${resolved.client}/${s.name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  await logResolve(
    `[stream] ${videoId}: probe fail ${resolved.client} (all header strats 403)`,
  );
  return false;
}

/**
 * Resolve a playable googlevideo URL for `videoId` via WEB_REMIX only.
 * Returns `null` on failure (no other resolver).
 */
export async function resolveWebRemixStream(
  videoId: string,
): Promise<ResolvedWebStream | null> {
  if (!videoId || videoId.length > 20) return null;

  try {
    const raw = await resolveViaRawPlayer(videoId);
    if (raw?.url && (await probeStreamUrl(videoId, raw))) return raw;

    const viaYt = await resolveViaYoutubei(videoId);
    if (viaYt?.url && (await probeStreamUrl(videoId, viaYt))) return viaYt;

    await logResolve(`[stream] ${videoId}: web_remix miss`);
    return null;
  } catch (e) {
    await logResolve(
      `[stream] ${videoId}: web_remix failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/** Kick off youtubei session create early so the first play is faster. */
export function warmStreamResolveSession(): void {
  void getInnertube().catch(() => {
    /* ignore — play path will retry */
  });
}
