import { invoke } from "@tauri-apps/api/core";
import { resolveWebRemixStream } from "@/lib/innertube/stream-resolve";
import { isPremium } from "@/lib/store/premium";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The Rust side runs a tiny axum server on a random localhost port that
 * streams audio progressively from a frontend-resolved WEB_REMIX URL
 * (only strategy — no ANDROID_VR / yt-dlp). We query the port once and
 * build stream URLs from it.
 *
 * Non-Premium / signed-out users append `?ephemeral=1` to every stream
 * URL. The Rust handler reads that as "serve playback but write to a
 * session-only cache directory that gets wiped on every app startup" —
 * a persistent on-disk library of tracks is a Premium-only feature.
 */

let baseUrlPromise: Promise<string> | null = null;

async function fetchBaseUrl(): Promise<string> {
  // Up to ~2s of retries — the server starts asynchronously from Tauri
  // setup() and may not be listening yet when the first track plays.
  for (let i = 0; i < 20; i++) {
    try {
      return await invoke<string>("get_stream_base_url");
    } catch (e) {
      if (i === 19) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("unreachable");
}

export function getStreamBaseUrl(): Promise<string> {
  if (!baseUrlPromise) {
    baseUrlPromise = fetchBaseUrl().catch((e) => {
      baseUrlPromise = null; // retry next call
      throw e;
    });
  }
  return baseUrlPromise;
}

function ephemeralSuffix(): string {
  return isPremium() ? "" : "?ephemeral=1";
}

/**
 * Desktop Chrome UA — must match the WEB_REMIX client used for decipher
 * when downloading client-locked googlevideo URLs.
 */
const WEB_REMIX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * How long we wait for WEB_REMIX *before* handing the audio element a
 * `/stream` URL. Rust also polls `pre_resolved` after the GET so a late
 * register still starts the download. Don't block 20s here — that made
 * long tracks look dead.
 */
// Warm path is usually <2s; give cold youtubei a bit more room since
// there is no secondary resolver.
const WEB_RESOLVE_HEADSTART_MS = 6_000;

/**
 * Absolute ceiling for a background WEB_REMIX attempt after the stream
 * URL is already live. Past this we stop trying to register.
 */
const WEB_RESOLVE_BACKGROUND_MS = 18_000;

async function registerWebRemixSource(
  videoId: string,
  resolved: {
    videoId: string;
    url: string;
    mimeType: string;
    itag?: number;
    client: string;
    userAgent?: string;
  },
): Promise<void> {
  // UA must match the client that signed the googlevideo URL or GV returns 403.
  // Pass both casings — Tauri command arg rename has been flaky for this field.
  const ua = resolved.userAgent || WEB_REMIX_UA;
  await invoke("register_stream_source", {
    videoId: resolved.videoId,
    video_id: resolved.videoId,
    url: resolved.url,
    userAgent: ua,
    user_agent: ua,
  });
  console.info(
    `[stream] registered ${resolved.client} →`,
    videoId,
    resolved.mimeType,
    resolved.itag != null ? `itag=${resolved.itag}` : "",
  );
  void invoke("log_stream_line", {
    line: `[stream] ${videoId}: web_remix registered (${resolved.client}, itag=${resolved.itag ?? "?"})`,
  }).catch(() => {});
}

/**
 * Resolve + register WEB_REMIX without blocking the caller longer than
 * `headstartMs`. On miss/timeout the promise settles with false and the
 * background attempt may still register while Rust polls.
 */
function kickWebRemixResolve(
  videoId: string,
  headstartMs: number,
): Promise<boolean> {
  let settled = false;
  const work = (async (): Promise<boolean> => {
    try {
      const resolved = await Promise.race([
        resolveWebRemixStream(videoId),
        new Promise<null>((r) =>
          setTimeout(() => r(null), WEB_RESOLVE_BACKGROUND_MS),
        ),
      ]);
      if (!resolved?.url) {
        if (!settled) {
          console.info("[stream] WEB_REMIX resolve miss for", videoId);
          void invoke("log_stream_line", {
            line: `[stream] ${videoId}: web_remix miss`,
          }).catch(() => {});
        }
        return false;
      }
      await registerWebRemixSource(videoId, resolved);
      return true;
    } catch (e) {
      console.info("[stream] WEB_REMIX resolve error:", e);
      void invoke("log_stream_line", {
        line: `[stream] ${videoId}: web_remix error: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }).catch(() => {});
      return false;
    }
  })();

  return Promise.race([
    work.then((ok) => {
      settled = true;
      return ok;
    }),
    new Promise<boolean>((r) =>
      setTimeout(() => {
        if (!settled) {
          console.info(
            "[stream] WEB_REMIX still running; starting /stream for",
            videoId,
          );
        }
        r(false);
      }, headstartMs),
    ),
  ]);
}

/**
 * Build the local progressive stream URL for a videoId.
 *
 * Kicks WEB_REMIX resolve (youtubei.js + cookies) with a short head-start,
 * then returns `/stream/:id`. Rust polls for the registered URL and
 * downloads via Music Origin + cookies. WEB_REMIX is the only resolver.
 */
export async function streamUrlFor(videoId: string): Promise<string> {
  const basePromise = getStreamBaseUrl();
  // Fire-and-forget with head-start: await only a brief window so a warm
  // session can still win the race, then let /stream start.
  await kickWebRemixResolve(videoId, WEB_RESOLVE_HEADSTART_MS);
  const base = await basePromise;
  return `${base}/stream/${encodeURIComponent(videoId)}${ephemeralSuffix()}`;
}

const metaWritten = new Set<string>();

/**
 * Persist a cached track's display metadata (title + artist) to a
 * sidecar next to its `.webm`, so the Storage tab can show a real name
 * for the track without waiting on — or being limited to — the library
 * walk. Only meaningful for the persistent (Premium) cache; ephemeral
 * streams are wiped on launch, so there's nothing on disk to label.
 *
 * `videoId` is the STREAM id (the file that actually lands on disk),
 * which may differ from the queue's display id when the user has toggled
 * a track to its music-video version. The title/artist still describe
 * the track and are correct either way. Fire-and-forget and deduped per
 * session; a failed write is retried on the next play.
 */
export async function saveTrackMeta(
  videoId: string,
  track: Pick<QueueTrack, "title" | "subtitle" | "artists"> | undefined,
): Promise<void> {
  if (!isPremium()) return;
  if (!track?.title) return;
  if (metaWritten.has(videoId)) return;
  metaWritten.add(videoId);
  const artist =
    track.artists?.map((a) => a.name).join(", ") || track.subtitle || null;
  try {
    await invoke("set_cache_meta", { videoId, title: track.title, artist });
  } catch {
    metaWritten.delete(videoId);
  }
}

/**
 * Drop the in-memory "already labelled" log.
 * Call after the disk cache is cleared or the account switches —
 * otherwise we'd never re-write metadata sidecars for tracks that are
 * gone from disk but still remembered as labelled.
 */
export function clearPrefetchMemo(): void {
  metaWritten.clear();
}
