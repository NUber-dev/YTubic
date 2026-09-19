import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

type YtdlpState = {
  phase: "downloading" | "ready" | "error";
  message?: string | null;
};

const TOAST_ID = "ytdlp-setup";

/**
 * Mount once in AppShell. Kicks off `ensure_ytdlp` on the Rust side
 * (managed yt-dlp and Node setup + throttled yt-dlp self-update)
 * and mirrors its `ytdlp-state` events into toasts.
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

    void listen<YtdlpState>("ytdlp-state", (e) => {
      const { phase, message } = e.payload;
      if (phase === "downloading") {
        sawDownloadRef.current = true;
        toast.loading("Setting up the audio engine…", {
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
        toast.error("Couldn't set up the audio engine", {
          id: TOAST_ID,
          duration: Infinity,
          description: message ?? undefined,
          action: {
            label: "Retry",
            onClick: () => {
              void invoke("ensure_ytdlp");
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
      void invoke("ensure_ytdlp").catch((err) => {
        console.error("[ytdlp] ensure_ytdlp failed:", err);
      });
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}
