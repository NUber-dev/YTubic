import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { createStore, del, get, set } from "idb-keyval";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 min — InnerTube responses rarely change
      gcTime: 1000 * 60 * 60 * 24, // 24h in cache so hydration from disk has something to return
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// DevTools escape hatch: console `import()` of this module gets a SEPARATE
// vite module instance (HMR `?t=` stamps), so the only way to poke the live
// cache from the console is through a window global.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__qc = queryClient;
}

const idbStore =
  typeof window !== "undefined"
    ? createStore("ytubic-cache", "query-cache")
    : undefined;

const idbStorage = {
  getItem: (key: string) =>
    idbStore
      ? get<string>(key, idbStore).then((value) => value ?? null)
      : Promise.resolve(null),
  setItem: (key: string, value: string) =>
    idbStore ? set(key, value, idbStore) : Promise.resolve(),
  removeItem: (key: string) =>
    idbStore ? del(key, idbStore) : Promise.resolve(),
};

/**
 * Persist the query cache to IndexedDB. On next launch the
 * `PersistQueryClientProvider` rehydrates queries from disk and shows
 * cached data instantly while a background refetch happens per
 * staleTime. Keys we don't want on disk (e.g. search by query) get
 * filtered out via `dehydrateOptions`.
 */
export const persister = createAsyncStoragePersister({
  storage: idbStorage,
  key: "ytubic-query-cache",
  throttleTime: 5000,
});

// Reclaim the old WebKitGTK localStorage quota after moving this cache.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("ytubic-query-cache");
  } catch {
    // Best-effort migration; persistence remains usable through IndexedDB.
  }
}

export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Which query keys are worth persisting across launches. */
export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  return (
    head === "home" ||
    head === "artist" ||
    head === "album" ||
    // The playlist route keys its data as "playlist-pages" (not "playlist"),
    // so the old entry never matched and playlists were never persisted.
    head === "playlist-pages" ||
    // Persisted so heart fills are correct on reload — fetching the
    // full list is 7+ continuation round-trips, you don't want to pay
    // that on every cold start.
    head === "liked-songs" ||
    // The Storage tab derives every cached-track title AND its
    // in-library status from this one walk (Liked Songs + all playlists
    // + all albums — dozens of round-trips). Without persistence a cold
    // start shows raw videoIds and "0 in library" until it finishes;
    // hydrating from disk makes that state correct on open, with a
    // background revalidate per staleTime. Large libraries that blow the
    // per-query byte budget simply fall back to the live walk.
    head === "library-tracks" ||
    // Lyrics are immutable per (title, artist, album, duration) tuple
    // and the LRCLIB / YTM round-trip is the slowest part of
    // a track switch. Persisting collapses repeat plays of the same
    // track across sessions to a free disk-cache hit. The
    // `staleTime: ONE_HOUR` in `useLyricsSources` still triggers a
    // background revalidate so newly-added LRCLIB entries surface
    // within an hour of the next play.
    head === "lyrics" ||
    // Chapter lists are tiny and change rarely; persisting them makes
    // the Chapters tab appear instantly on a repeat play of an OST.
    head === "chapters"
  );
}

/**
 * Hard ceiling per persisted query. Beyond this size the cost of
 * serializing + writing to disk on every mutation outweighs the
 * cold-start win. Liked-songs accounts of 5k+ tracks easily blow past
 * this, but the in-session fetch is fast enough that not persisting them
 * costs ~5 s on first cold start instead of frame-blocking serializes
 * forever after.
 */
const MAX_PERSIST_BYTES_PER_QUERY = 500 * 1024;

/**
 * Cheap-but-meaningful size estimate for a query's `data`. We don't
 * reach for `JSON.stringify` here since the persister itself will
 * stringify on dehydrate; `JSON.stringify` is what gets called
 * downstream so its byte count is the only one that matters.
 */
export function fitsInPersistBudget(data: unknown): boolean {
  try {
    return JSON.stringify(data).length <= MAX_PERSIST_BYTES_PER_QUERY;
  } catch {
    return false;
  }
}
