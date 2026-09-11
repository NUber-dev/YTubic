import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { diagLog } from "@/lib/diagnostics";

export type NonMusicSegment = { start: number; end: number };

const SPONSORBLOCK_API = "https://sponsor.ajay.app/api/skipSegments";
const CATEGORY = "music_offtopic";
const REQUEST_TIMEOUT_MS = 5000;

/**
 * The video id never leaves the machine: SponsorBlock's privacy endpoint
 * takes the first four hex characters of its SHA-256 and answers with
 * every video sharing that prefix, which we then filter locally.
 */
async function sha256HexPrefix(input: string, len: number): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

const cache = new Map<string, NonMusicSegment[]>();
const inflight = new Map<string, Promise<NonMusicSegment[]>>();

export async function fetchNonMusicSegments(
  videoId: string,
): Promise<NonMusicSegment[]> {
  const cached = cache.get(videoId);
  if (cached) return cached;
  const existing = inflight.get(videoId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const prefix = await sha256HexPrefix(videoId, 4);
      const url = `${SPONSORBLOCK_API}/${prefix}?category=${CATEGORY}&service=YouTube`;
      const started = performance.now();
      const res = await tauriFetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      diagLog(
        "network",
        `sponsor.ajay.app GET ${res.status} ${Math.round(performance.now() - started)}ms`,
      );
      if (res.status === 404 || !res.ok) {
        cache.set(videoId, []);
        return [];
      }
      const json = (await res.json()) as {
        videoID: string;
        segments: { segment: [number, number]; category: string }[];
      }[];
      const match = json.find((v) => v.videoID === videoId);
      const segments = (match?.segments ?? [])
        .filter((s) => s.category === CATEGORY)
        .map((s): NonMusicSegment => ({ start: s.segment[0], end: s.segment[1] }))
        .sort((a, b) => a.start - b.start);
      cache.set(videoId, segments);
      diagLog(
        "sponsorblock",
        `${videoId}: ${segments.length} non-music segment(s) ${segments
          .map((s) => `${Math.round(s.start)}-${Math.round(s.end)}s`)
          .join(", ")}`,
      );
      return segments;
    } catch (e) {
      diagLog("sponsorblock", `${videoId}: lookup failed (${String(e)})`);
      return [];
    } finally {
      inflight.delete(videoId);
    }
  })();

  inflight.set(videoId, promise);
  return promise;
}

/** The non-music stretch `position` is sitting in, if any. */
export function segmentAt(
  position: number,
  segments: NonMusicSegment[],
): NonMusicSegment | null {
  for (const seg of segments) {
    if (position < seg.start) break;
    if (position < seg.end) return seg;
  }
  return null;
}

export function segmentKey(seg: NonMusicSegment): string {
  return `${seg.start}-${seg.end}`;
}
