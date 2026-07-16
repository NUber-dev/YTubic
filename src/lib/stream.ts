import { invoke } from "@tauri-apps/api/core";
import { isPremium } from "@/lib/store/premium";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The Rust side runs a tiny axum server on a random localhost port that
 * streams yt-dlp output progressively. We query the port once and build
 * stream URLs from it.
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

export async function streamUrlFor(videoId: string): Promise<string> {
  const base = await getStreamBaseUrl();
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
