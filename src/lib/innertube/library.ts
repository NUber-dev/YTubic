import type { ShelfItem } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
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
