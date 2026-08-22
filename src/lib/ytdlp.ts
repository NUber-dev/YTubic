import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

type YtdlpState = {
  phase: "downloading" | "ready" | "error";
  message?: string | null;
};

const TOAST_ID = "ytdlp-setup";
// `ensure_ytdlp` does no network work until its 72-hour stamp expires. Polling
// hourly keeps a tray-resident process close to that cadence without turning
// a launch-time check into a second scheduler on the Rust side.
const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Mount once in AppShell. Kicks off `ensure_ytdlp` on the Rust side
 * (first-run download of the managed yt-dlp binary + throttled
 * self-update) and mirrors its `ytdlp-state` events into toasts.
 *
 * The listener is registered BEFORE the invoke so the very first
 * "downloading" event can't be missed. On the common path (binary
 * already present) the only event is "ready" with no prior
 * "downloading" — we stay silent to avoid a pointless toast on every
 * launch.
 */
export function useYtdlpSetup(): void {
  // True only after a "downloading" event — gates the success toast.
  const sawDownloadRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    let updateTimer: number | undefined;

    const runYtdlpCommand = (
      command: "ensure_ytdlp" | "check_ytdlp_update",
    ) => {
      void invoke(command).catch((err) => {
        console.error(`[ytdlp] ${command} failed:`, err);
      });
    };

    void listen<YtdlpState>("ytdlp-state", (e) => {
      const { phase, message } = e.payload;
      if (phase === "downloading") {
        sawDownloadRef.current = true;
        toast.loading("Setting up the audio engine (downloading yt-dlp)…", {
          id: TOAST_ID,
          duration: Infinity,
        });
      } else if (phase === "ready") {
        if (sawDownloadRef.current) {
          sawDownloadRef.current = false;
          toast.success("Audio engine ready", { id: TOAST_ID, duration: 4000 });
        }
      } else if (phase === "error") {
        sawDownloadRef.current = false;
        toast.error("Couldn't download yt-dlp — playback won't work", {
          id: TOAST_ID,
          duration: Infinity,
          description: message ?? undefined,
          action: {
            label: "Retry",
            onClick: () => {
              runYtdlpCommand("ensure_ytdlp");
            },
          },
        });
      }
    }).then((un) => {
      if (cancelled) {
        un();
        return;
      }
      dispose = un;
      // Listener is live — safe to start the Rust side now.
      runYtdlpCommand("ensure_ytdlp");
      // Closing the main window hides this process to the tray by default,
      // so it may not launch again for weeks. Keep checking while it lives;
      // the Rust-side stamp makes every early poll a local no-op.
      updateTimer = window.setInterval(
        () => runYtdlpCommand("check_ytdlp_update"),
        UPDATE_POLL_INTERVAL_MS,
      );
    });

    return () => {
      cancelled = true;
      dispose?.();
      if (updateTimer !== undefined) window.clearInterval(updateTimer);
    };
  }, []);
}
