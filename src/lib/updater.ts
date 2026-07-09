import { useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { useUpdateStore } from "@/lib/store/update";

const TOAST_ID = "app-update";

// One check-or-install flow at a time: a second trigger while a download
// is running must not start a parallel downloadAndInstall.
let busy = false;

/**
 * Check GitHub Releases for a newer version. On success the result is
 * pushed into `useUpdateStore`, which the sidebar banner reads. There
 * is no "available" toast anymore, the banner is that surface.
 *
 * `silent` is the startup path: no feedback when already up to date or
 * when the check fails (offline, rate-limit). The manual menu path
 * reports those outcomes.
 *
 * The updater can't run in `tauri dev`, so a manual check there seeds a
 * mock "available" update instead; the whole banner flow can then be
 * reviewed end to end (the install itself is simulated).
 */
export async function checkForUpdates({ silent }: { silent: boolean }): Promise<void> {
  if (import.meta.env.DEV) {
    if (!silent) useUpdateStore.getState().setAvailable("9.9.9", null);
    return;
  }
  if (busy) return;
  busy = true;
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
      if (!silent) toast.success("You're on the latest version.", { id: TOAST_ID });
      return;
    }

    useUpdateStore.getState().setAvailable(update.version, update);
  } finally {
    busy = false;
  }
}

/**
 * Start download + install for the update currently in the store (the
 * banner's click when it's showing "available"/"error"). A real update
 * handle → the plugin does the work; no handle → the dev preview runs a
 * simulated download.
 */
export async function beginUpdateInstall(): Promise<void> {
  const { phase, handle } = useUpdateStore.getState();
  if (phase !== "available" && phase !== "error") return;
  if (busy) return;
  busy = true;
  try {
    if (handle) await runRealInstall(handle);
    else await runMockInstall();
  } finally {
    busy = false;
  }
}

/**
 * Restart into the freshly-installed update (from the banner or the
 * installed toast). In the dev preview there's nothing to restart into,
 * so it just clears the flow and says so.
 */
export function restartToUpdate(): void {
  if (useUpdateStore.getState().handle) {
    void relaunch();
  } else {
    useUpdateStore.getState().reset();
    toast.success("Preview only: a real update would restart here.", {
      id: TOAST_ID,
      duration: 4000,
    });
  }
}

async function runRealInstall(update: Update): Promise<void> {
  const store = useUpdateStore.getState();
  let total = 0;
  let received = 0;
  store.setDownloading(0);
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          store.setDownloading(0);
          break;
        case "Progress": {
          received += event.data.chunkLength;
          const pct = total > 0 ? Math.round((received / total) * 100) : null;
          store.setDownloading(pct);
          break;
        }
        case "Finished":
          store.setInstalling();
          break;
      }
    });
  } catch (e) {
    // The banner's error phase ("Update failed / Click to retry") is
    // the surface for this now; no toast.
    store.setError(String(e));
    return;
  }
  store.setReady();
}

async function runMockInstall(): Promise<void> {
  const store = useUpdateStore.getState();
  store.setDownloading(0);

  // Simulated download: tick 0 -> 100 over ~2.5s.
  await new Promise<void>((resolve) => {
    let pct = 0;
    const timer = window.setInterval(() => {
      pct += 10;
      if (pct >= 100) {
        window.clearInterval(timer);
        store.setDownloading(100);
        resolve();
      } else {
        store.setDownloading(pct);
      }
    }, 250);
  });

  store.setInstalling();
  await new Promise<void>((r) => window.setTimeout(r, 800));

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
