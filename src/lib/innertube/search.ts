import type { Shelf, SearchResults } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawSearch,
  type YtNode,
} from "./shared";

/**
 * YTM search filter params.
 * (Obtained from the YTM web client; these are stable "pageParameter" strings.)
 */
export const SEARCH_FILTERS = {
  all: undefined,
  songs: "EgWKAQIIAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  videos: "EgWKAQIQAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  albums: "EgWKAQIYAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  artists: "EgWKAQIgAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  playlists: "EgWKAQIoAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
} as const;

export type SearchFilter = keyof typeof SEARCH_FILTERS;

export async function fetchSearch(
  query: string,
  filter: SearchFilter = "all",
): Promise<SearchResults> {
  if (!query.trim()) return { query, shelves: [] };

  const json = await rawSearch(query, SEARCH_FILTERS[filter]);

  const tabs: YtNode[] =
    json?.contents?.tabbedSearchResultsRenderer?.tabs ?? [];
  const sections: YtNode[] =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ??
    json?.contents?.sectionListRenderer?.contents ??
    [];

  const shelfNodes = collectShelfNodes(sections);

  const shelves: Shelf[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items, display } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    shelves.push({ id: `${title}-${i}`, title, items, display });
  });

  return { query, shelves };
}
