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

const prefetched = new Set<string>();

/**
 * Warm the disk cache for a videoId in the background. No-ops if we
 * already fired a prefetch for this id in this session, or if the user
 * isn't on Premium — pre-warming a session-only cache doesn't help once
 * the user advances past the prefetched track (the next app launch
 * wipes it anyway).
 *
 * The server itself is idempotent on a per-file basis (checks .part /
 * .webm existence), so re-firing is cheap but still skippable.
 */
export async function prefetchStream(videoId: string): Promise<void> {
  if (!isPremium()) return;
  if (prefetched.has(videoId)) return;
  prefetched.add(videoId);
  try {
    const base = await getStreamBaseUrl();
    // Fire-and-forget — server returns 200/202 immediately and caches
    // bytes in the background. fetch() only rejects on network errors, so an
    // HTTP 4xx/5xx (yt-dlp spawn/extractor failure) resolves normally — drop
    // the warm mark on an error status so the id is retried later.
    const res = await fetch(`${base}/prefetch/${encodeURIComponent(videoId)}`);
    if (!res.ok) prefetched.delete(videoId);
  } catch {
    // If it fails we'll just fall through to on-demand fetch later.
    prefetched.delete(videoId);
  }
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
 * session; a failed write is retried on the next play/prefetch.
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
 * Drop the in-memory "already prefetched" / "already labelled" logs.
 * Call after the disk cache is cleared or the account switches —
 * otherwise we'd never re-prefetch tracks that are gone from disk but
 * still remembered as "warm", nor re-write their metadata sidecars.
 */
export function clearPrefetchMemo(): void {
  prefetched.clear();
  metaWritten.clear();
}
