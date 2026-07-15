import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { fetchLibraryTracks } from "@/lib/innertube/library";
import { formatBytes } from "@/lib/format";
import { queryClient } from "@/lib/query-client";
import { clearPrefetchMemo } from "@/lib/stream";
import { currentTrack, usePlaybackStore } from "@/lib/store/playback";
import {
  useSettingsStore,
  type CacheAutoCleanPeriod,
} from "@/lib/store/settings";

/** How long after the last completed sweep the next one comes due.
 *  Exported so the Storage settings row can show the same next-run time
 *  the sweep itself computes — one source of truth for the cadence. */
export const PERIOD_MS: Record<Exclude<CacheAutoCleanPeriod, "off">, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** How often the hook re-checks whether a sweep is due. Cheap no-op
 *  (two localStorage reads) between due dates. */
const TICK_MS = 30 * 60 * 1000;

async function sweep(): Promise<void> {
  const { cacheAutoClean, lastCacheCleanAt } = useSettingsStore.getState();
  if (cacheAutoClean === "off") return;
  if (Date.now() - lastCacheCleanAt < PERIOD_MS[cacheAutoClean]) return;

  // Every precondition below soft-fails: skip this tick and let the
  // next one retry. A background chore should never surface errors.
  const loggedIn = await invoke<boolean>("is_logged_in").catch(() => false);
  if (!loggedIn) return;

  // Everything the library pins: liked songs, saved/created playlists,
  // saved albums. `fetchLibraryTracks` throws if any source fails —
  // a partial set would mark whole playlists as junk, so skip the tick.
  let libraryTracks;
  try {
    libraryTracks = await fetchLibraryTracks();
  } catch {
    return;
  }
  // An empty union is far more likely a transient API hiccup than a
  // genuinely empty library — and treating it as truth would wipe the
  // entire cache. Never sweep on that signal.
  if (libraryTracks.length === 0) return;

  const cache = await invoke<{ videoId: string }[]>("list_cache").catch(
    () => null,
  );
  if (!cache || cache.length === 0) return;

  const libraryIds = new Set(libraryTracks.map((t) => t.id));
  // Leave the now-playing track alone even if it isn't in the library —
  // its cache file may still be mid-download, and yanking it just
  // forces a pointless re-stream on the next seek.
  const playingId = currentTrack(usePlaybackStore.getState())?.videoId;
  const targets = cache
    .filter((e) => !libraryIds.has(e.videoId) && e.videoId !== playingId)
    .map((e) => e.videoId);

  if (targets.length === 0) {
    // Nothing to delete still counts as a completed sweep — without
    // the stamp we'd re-walk the whole library on every tick until
    // the next period boundary.
    useSettingsStore.getState().markCacheCleaned();
    return;
  }

  const freed = await invoke<number>("delete_cache_entries", {
    videoIds: targets,
  });
  useSettingsStore.getState().markCacheCleaned();
  // Deleted files may have been marked "already prefetched" — drop the
  // memo so they become prefetchable again, and refresh any open
  // Settings cache list.
  clearPrefetchMemo();
  void queryClient.invalidateQueries({ queryKey: ["cache-list"] });
  toast.info(
    `Cache auto-clean: removed ${targets.length} track${
      targets.length === 1 ? "" : "s"
    } not in your library · freed ${formatBytes(freed)}`,
  );
}

/**
 * Background sweep that deletes cached tracks missing from the user's
 * library (liked songs, playlists, albums), on the cadence picked in
 * Settings. Mounted once in AppShell (main window only — the floating
 * player has its own React root and must not double-run this).
 *
 * The first check is delayed ~20 s so launch isn't competing with the
 * home-feed fetch and the cookie jar / InnerTube client are warm;
 * after that a 30-min interval catches long-running sessions.
 */
export function useCacheAutoClean(): void {
  const period = useSettingsStore((s) => s.cacheAutoClean);
  useEffect(() => {
    if (period === "off") return;
    const run = () => {
      void sweep().catch((e) => {
        console.warn("[cache-autoclean] sweep failed:", e);
      });
    };
    const first = window.setTimeout(run, 20_000);
    const every = window.setInterval(run, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [period]);
}
