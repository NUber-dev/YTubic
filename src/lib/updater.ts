import { useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { useUpdateStore } from "@/lib/store/update";

const TOAST_ID = "app-update";

/** Upstream's latest release: the real release notes and the official build. */
export const UPSTREAM_RELEASES_URL =
  "https://github.com/NUber-dev/YTubic/releases/latest";

// Fork note: this build has NO self-install path, on purpose.
//
// The updater endpoint points at the UPSTREAM repo's releases, and those
// artifacts are the upstream dev's own builds — they carry none of this fork's
// patches (global volume hotkeys). Installing one would quietly replace this
// build and drop those features, and it would succeed: upstream signs its
// artifacts with the key this config already trusts. So we keep the *check*
// (it's how we learn a new version shipped) and drop `downloadAndInstall`
// entirely. Updating a fork means merging upstream and rebuilding, which is
// what ForkUpdateDialog explains on every launch while we're behind.

// One check at a time: a second trigger while one is in flight is a no-op.
let busy = false;

/**
 * Check upstream's GitHub Releases for a newer version. On success the result
 * is pushed into `useUpdateStore`, which the launch dialog and the sidebar
 * banner both read.
 *
 * `silent` is the startup path: no feedback when already up to date or when
 * the check fails (offline, rate-limit). The manual menu path reports those
 * outcomes.
 *
 * The updater can't run in `tauri dev`, so a manual check there seeds a mock
 * "available" update instead; the dialog and banner can then be reviewed end
 * to end.
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

/** Open upstream's release notes in the default browser. */
export function openUpstreamReleaseNotes(): void {
  openUrl(UPSTREAM_RELEASES_URL).catch((e) => toast.error(String(e)));
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
