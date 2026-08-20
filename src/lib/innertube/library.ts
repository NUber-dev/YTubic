import type { ShelfItem } from "./types";
import {
  collectContinuationItems,
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
  readPagingToken,
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
  const sectionList: YtNode | undefined =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer;
  const sections: YtNode[] = sectionList?.contents ?? [];

  const shelfNodes = collectShelfNodes(sections);
  // A library shelf is paged: the browse response carries roughly the first
  // 25 rows and a token for the rest. Without following it, a library of 30+
  // playlists (or artists, or albums) renders as ~25 and the remainder simply
  // isn't there. Shelves are walked in parallel because a library page can
  // hold several and they page independently.
  const paged = await Promise.all(
    shelfNodes.map(async (wrapper, i) => {
      const shelf: YtNode =
        wrapper.musicShelfRenderer ??
        wrapper.musicCarouselShelfRenderer ??
        wrapper;
      // The token normally sits on the grid/shelf itself. When a one-shelf
      // page hangs it off the section list instead, that is unambiguously
      // this shelf's, so take it rather than render a truncated library.
      const token =
        readPagingToken(shelf) ??
        (shelfNodes.length === 1 ? readPagingToken(sectionList) : undefined);
      const rest = await collectContinuationItems(token);
      return { wrapper, i, rest };
    }),
  );

  const out: LibrarySection[] = [];
  for (const { wrapper, i, rest } of paged) {
    const { title, items } = mapShelfWrapper(wrapper, i);
    // Continuation rows arrive as the same renderers the first page used, so
    // they map through the identical path rather than a parallel one.
    const more = rest.length
      ? mapShelfWrapper({ musicShelfRenderer: { contents: rest } }, i).items
      : [];
    // Dedupe across the page boundary: the row keys the grid renders with
    // are these ids, so a row YTM happens to repeat would collide.
    const seen = new Set<string>();
    const all = [...items, ...more].filter((it) => {
      if (!it.id) return true;
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
    if (all.length === 0) continue;
    out.push({ id: `${title}-${i}`, title, items: all });
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
