import type { ShelfItem } from "./types";
import {
  collectShelfNodes,
  findContinuationToken,
  mapShelfWrapper,
  rawBrowse,
  rawBrowseContinuation,
  type YtNode,
} from "./shared";

/**
 * Fetch the user's library landing page. Returns a list of "shelves"
 * covering playlists / albums / artists / episodes the user follows.
 *
 * Requires authenticated cookies (Settings → Connect account). Without
 * them YouTube redirects to a generic explore page.
 */
export type LibrarySection = {
  id: string;
  title: string;
  items: ShelfItem[];
};

async function browseSections(browseId: string): Promise<LibrarySection[]> {
  const json = await rawBrowse(browseId);
  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const sections: YtNode[] =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

  const shelfNodes = collectShelfNodes(sections);
  const out: LibrarySection[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    out.push({ id: `${title}-${i}`, title, items });
  });

  let token = findContinuationToken(json);
  for (let i = 0; token && i < 100; i++) {
    try {
      const nextPageJson = await rawBrowseContinuation(token);
      const cc = nextPageJson?.continuationContents;
      if (!cc) break;

      let nextShelfNodes: YtNode[] = [];
      if (cc.gridContinuation?.items) {
        nextShelfNodes = collectShelfNodes([{ gridRenderer: { items: cc.gridContinuation.items } }]);
      } else if (cc.sectionListContinuation?.contents) {
        nextShelfNodes = collectShelfNodes(cc.sectionListContinuation.contents);
      } else if (cc.musicShelfContinuation?.contents) {
        nextShelfNodes = collectShelfNodes([{ musicShelfRenderer: { contents: cc.musicShelfContinuation.contents } }]);
      } else if (cc.musicPlaylistShelfContinuation?.contents) {
        nextShelfNodes = collectShelfNodes([{ musicShelfRenderer: { contents: cc.musicPlaylistShelfContinuation.contents } }]);
      }

      let addedAny = false;
      nextShelfNodes.forEach((wrapper, j) => {
        const { items } = mapShelfWrapper(wrapper, j);
        if (items.length > 0) {
          addedAny = true;
          if (out.length === 0) {
            out.push({ id: "library-continuation-0", title: "Library", items: [] });
          }
          out[0].items.push(...items);
        }
      });

      if (!addedAny) break;

      const nextToken = findContinuationToken(nextPageJson);
      token = nextToken === token ? undefined : nextToken;
    } catch (e) {
      if (import.meta.env.DEV) {
        console.debug("[library] continuation fetch failed:", e);
      }
      break;
    }
  }

  return out;
}

export function fetchLibraryPlaylists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_playlists");
}

export function fetchLibraryAlbums(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_liked_albums");
}

export function fetchLibraryArtists(): Promise<LibrarySection[]> {
  return browseSections("FEmusic_library_corpus_artists");
}

/**
 * Liked songs playlist. YTM uses the magic id `LM` (auto-generated).
 */
export async function fetchLikedSongs(): Promise<ShelfItem[]> {
  const { fetchPlaylist } = await import("./playlist");
  const page = await fetchPlaylist("LM");
  return page.tracks;
}

/**
 * Union of every track the user's library pins: Liked Songs, every
 * saved/created playlist, and saved albums. Deduped by videoId.
 *
 * This is the "protected set" for cache management — the Storage tab
 * and the auto-clean sweep treat anything outside it as deletable, so
 * it must err toward completeness: any source failing to load throws
 * instead of returning a partial union that would silently mark whole
 * playlists as junk. (A playlist that loads but loses a continuation
 * page mid-walk is still truncated — `fetchPlaylist` tolerates that —
 * but the blast radius is a few re-downloadable cache files, not the
 * whole library.)
 */
export async function fetchLibraryTracks(): Promise<ShelfItem[]> {
  const { fetchPlaylist } = await import("./playlist");
  const { fetchAlbum } = await import("./album");

  const [playlistSections, albumSections] = await Promise.all([
    fetchLibraryPlaylists(),
    fetchLibraryAlbums(),
  ]);

  // Liked Songs (`LM`) also shows up in the playlists shelf — skip the
  // duplicate so its continuations aren't walked twice.
  const playlistIds = playlistSections
    .flatMap((s) => s.items)
    .map((p) => p.id.replace(/^VL/, ""))
    .filter((id) => id && id !== "LM");
  const albumIds = albumSections
    .flatMap((s) => s.items)
    .map((a) => a.id)
    .filter(Boolean);

  const byId = new Map<string, ShelfItem>();
  const add = (tracks: ShelfItem[]) => {
    for (const t of tracks) {
      if (t.id && !byId.has(t.id)) byId.set(t.id, t);
    }
  };

  add(await fetchPlaylist("LM").then((p) => p.tracks));

  // Small worker pool: libraries can hold dozens of playlists/albums
  // and each costs at least one InnerTube round-trip. Four in flight
  // keeps total latency sane without hammering the endpoint.
  const jobs: (() => Promise<ShelfItem[]>)[] = [
    ...playlistIds.map(
      (id) => () => fetchPlaylist(id).then((p) => p.tracks),
    ),
    ...albumIds.map((id) => () => fetchAlbum(id).then((a) => a.tracks)),
  ];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(4, jobs.length) },
    async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        add(await job());
      }
    },
  );
  await Promise.all(workers);

  return [...byId.values()];
}
