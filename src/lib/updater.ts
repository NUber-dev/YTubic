import { useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { useUpdateStore } from "@/lib/store/update";

const TOAST_ID = "app-update";

// One check at a time, and one download at a time: a second trigger
// while either is running must not start a parallel copy.
let checking = false;
let downloading = false;

/**
 * Check GitHub Releases for a newer version. A found update is handed
 * straight to the background downloader: nothing asks the user to
 * start it, the sidebar banner only appears once the package is on
 * disk and all that's left is a restart (the Cursor/VS Code model).
 *
 * `silent` is the startup path: no feedback when already up to date or
 * when the check fails (offline, rate-limit). The manual menu path
 * reports those outcomes.
 *
 * While an update is already downloading or ready, a repeat check is a
 * no-op: the About dialog runs one on every open and must not restart
 * the download. An errored download is retried by the next check.
 *
 * The updater can't run in `tauri dev`, so a manual check there plays a
 * simulated download instead; the whole banner flow can then be
 * reviewed end to end (the restart itself is simulated).
 */
export async function checkForUpdates({
  silent,
}: {
  silent: boolean;
}): Promise<void> {
  const store = useUpdateStore.getState();
  if (
    store.phase === "downloading" ||
    store.phase === "installing" ||
    store.phase === "ready"
  ) {
    return;
  }

  if (import.meta.env.DEV) {
    if (!silent) void downloadUpdate("9.9.9", null);
    return;
  }
  if (checking) return;
  checking = true;
  try {
    let update: Update | null;
    try {
      update = await check();
    } catch (e) {
      if (!silent) {
        toast.error("Couldn't check for updates", {
          id: TOAST_ID,
          description: String(e),
        });
      }
      return;
    }

    if (!update) {
      if (!silent)
        toast.success("You're on the latest version.", { id: TOAST_ID });
      return;
    }

    // Detached on purpose: the caller (About's "Checking…" spinner)
    // only waits for the check, the download runs on its own.
    void downloadUpdate(update.version, update);
  } finally {
    checking = false;
  }
}

/**
 * Retry the download after a failure (the banner's and About's click
 * in the error phase). Reuses the handle the failed attempt left in
 * the store; a null handle is the dev preview and replays the mock.
 */
export async function retryUpdateDownload(): Promise<void> {
  const { phase, version, handle } = useUpdateStore.getState();
  if (phase !== "error") return;
  await downloadUpdate(version ?? "", handle);
}

/**
 * Restart into the downloaded update (from the banner or About). The
 * package is already here, so this hands it to the installer and
 * relaunches: on Windows the plugin starts the silent installer and
 * exits the process itself, the installer brings the app back; on
 * macOS/Linux `install` returns after swapping the bundle and the
 * relaunch is ours to do. In the dev preview there's nothing to
 * restart into, so it just clears the flow and says so.
 */
export async function restartToUpdate(): Promise<void> {
  const store = useUpdateStore.getState();
  if (store.phase !== "ready") return;
  const { handle } = store;
  if (!handle) {
    store.reset();
    toast.success("Preview only: a real update would restart here.", {
      id: TOAST_ID,
      duration: 4000,
    });
    return;
  }
  store.setInstalling();
  try {
    await handle.install();
    await relaunch();
  } catch (e) {
    // The banner's error phase ("Update failed / Click to retry") is
    // the surface for this; a retry re-downloads and tries again.
    store.setError(String(e));
  }
}

async function downloadUpdate(
  version: string,
  handle: Update | null,
): Promise<void> {
  if (downloading) return;
  downloading = true;
  try {
    if (handle) await runRealDownload(version, handle);
    else await runMockDownload(version);
  } finally {
    downloading = false;
  }
}

async function runRealDownload(version: string, update: Update): Promise<void> {
  const store = useUpdateStore.getState();
  let total = 0;
  let received = 0;
  store.setDownloading(version, update);
  try {
    await update.download((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          store.setProgress(0);
          break;
        case "Progress": {
          received += event.data.chunkLength;
          const pct = total > 0 ? Math.round((received / total) * 100) : null;
          store.setProgress(pct);
          break;
        }
        case "Finished":
          break;
      }
    });
  } catch (e) {
    store.setError(String(e));
    return;
  }
  store.setReady();
}

async function runMockDownload(version: string): Promise<void> {
  const store = useUpdateStore.getState();
  store.setDownloading(version, null);

  // Simulated download: tick 0 -> 100 over ~2.5s.
  await new Promise<void>((resolve) => {
    let pct = 0;
    const timer = window.setInterval(() => {
      pct += 10;
      if (pct >= 100) {
        window.clearInterval(timer);
        store.setProgress(100);
        resolve();
      } else {
        store.setProgress(pct);
      }
    }, 250);
  });

  store.setReady();
}

/**
 * Mount once in AppShell: quiet update check shortly after launch.
 * Delayed a few seconds so it never competes with first paint, feed
 * loading, or the yt-dlp bootstrap for attention/bandwidth.
 */
export function useUpdateStartupCheck(): void {
  useEffect(() => {
    const t = window.setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);
}
