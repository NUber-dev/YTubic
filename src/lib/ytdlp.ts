import { useEffect } from "react";
import { warmStreamResolveSession } from "@/lib/innertube/stream-resolve";

/**
 * Mount once in AppShell.
 *
 * Playback is WEB_REMIX-only now — we no longer download or invoke the
 * managed yt-dlp binary on launch. This hook only warms the youtubei
 * Music player session so the first play doesn't pay the full dynamic-
 * import cost inside the resolve budget.
 *
 * --- yt-dlp re-enable (commented) ---
 * Previously this mounted `ensure_ytdlp` + `ytdlp-state` toasts. To bring
 * that back, restore the listener/invoke from git history and re-enable
 * the yt-dlp branch in `spawn_downloader` (src-tauri/src/lib.rs).
 */
export function useYtdlpSetup(): void {
  useEffect(() => {
    warmStreamResolveSession();
  }, []);
}
