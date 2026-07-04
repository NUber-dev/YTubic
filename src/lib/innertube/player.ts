import { invoke } from "@tauri-apps/api/core";

/**
 * /player resolver — via `yt-dlp` sidecar.
 *
 * Why not youtubei.js + fetch-the-URL directly?
 * YouTube now serves "client-locked" stream URLs — signed so that only
 * requests matching the issuing client's TLS fingerprint + headers are
 * accepted by googlevideo. Our Rust reqwest proxy consistently got 403;
 * WebView2 direct loads did too. yt-dlp side-steps the whole problem by
 * handling the modern PoToken / visitor_data / signature dance and
 * returning a URL that actually plays.
 *
 * Requires `yt-dlp` to be on PATH during development. For production
 * we'll ship it as a Tauri sidecar.
 */

export type AudioFormat = {
  itag: number;
  url: string;
  mimeType: string;
  codec: string;
  bitrate: number;
  averageBitrate?: number;
  contentLength?: number;
  approxDurationMs?: number;
};

export type ResolvedStream = {
  videoId: string;
  title: string;
  author?: string;
  durationSeconds: number;
  client: string;
  format: AudioFormat;
};

type YtDlpJson = {
  id: string;
  title?: string;
  uploader?: string;
  duration?: number;
  requested_formats?: YtDlpFormat[];
  url?: string;
  format_id?: string;
  ext?: string;
  acodec?: string;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
};

type YtDlpFormat = {
  format_id: string;
  url: string;
  ext?: string;
  acodec?: string;
  vcodec?: string;
  abr?: number;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
};

export async function resolveStream(videoId: string): Promise<ResolvedStream> {
  if (import.meta.env.DEV) {
    console.debug("[player] yt-dlp resolve:", videoId);
  }

  // Delegates to a Rust command that runs `yt-dlp -j -f bestaudio`.
  // Keeping the subprocess on the Rust side sidesteps Tauri's
  // shell-scope validation quirks.
  let stdout: string;
  try {
    stdout = await invoke<string>("resolve_stream_ytdlp", { videoId });
  } catch (e) {
    throw new Error(`yt-dlp: ${String(e)}`);
  }

  let json: YtDlpJson;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `yt-dlp: invalid JSON (${(e as Error).message}): ${stdout.slice(0, 200)}`,
    );
  }

  // When -f bestaudio matches a single format, yt-dlp puts its fields at
  // the root of the JSON (url/format_id/acodec/abr). For multi-format
  // selections it nests under requested_formats[].
  const single = json.url ? json : json.requested_formats?.[0];
  if (!single?.url) {
    throw new Error("yt-dlp returned no stream URL");
  }

  const bitrateKbps = single.abr ?? 0;
  const acodec = single.acodec ?? "";
  const ext = single.ext ?? "";
  const mimeType =
    ext === "m4a" || acodec.startsWith("mp4a")
      ? "audio/mp4"
      : ext === "webm" || acodec === "opus"
        ? "audio/webm"
        : "audio/*";

  if (import.meta.env.DEV) {
    console.debug(
      "[player] yt-dlp ✓",
      videoId,
      "format=",
      single.format_id,
      "codec=",
      acodec,
      "bitrate=",
      bitrateKbps,
      "url=",
      single.url.slice(0, 100) + "…",
    );
  }

  return {
    videoId,
    title: json.title ?? "",
    author: json.uploader,
    durationSeconds: json.duration ?? 0,
    client: `yt-dlp/${single.format_id ?? "?"}`,
    format: {
      itag: 0, // yt-dlp doesn't expose itag here; irrelevant for playback
      url: single.url,
      mimeType,
      codec: acodec,
      bitrate: Math.round(bitrateKbps * 1000),
      averageBitrate: Math.round(bitrateKbps * 1000),
      contentLength: single.filesize ?? single.filesize_approx,
    },
  };
}
