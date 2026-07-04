import type { Shelf } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
  rawBrowseContinuation,
  type YtNode,
} from "./shared";

export type FeedPage = {
  shelves: Shelf[];
  nextCursor?: string;
};

// YT Music browse IDs for the Explore tab and its three sub-feeds.
// Surfaced from the WEB_REMIX client; identical IDs work for anonymous
// and signed-in users.
const BROWSE_ID = {
  explore: "FEmusic_explore",
  charts: "FEmusic_charts",
  newReleases: "FEmusic_new_releases",
  moodsAndGenres: "FEmusic_moods_and_genres",
} as const;

async function fetchBrowseFeedPage(
  browseId: string,
  options: { params?: string; cursor?: string } = {},
): Promise<FeedPage> {
  const { params, cursor } = options;
  const json = cursor
    ? await rawBrowseContinuation(cursor)
    : await rawBrowse(browseId, params);

  const { sections, nextCursor } = cursor
    ? extractContinuationPage(json)
    : extractInitialPage(json);

  const shelfNodes = collectShelfNodes(sections);

  const cursorTag = cursor ? cursor.slice(0, 12) : "init";
  // Title-based id with a per-page collision counter — see home.ts for the
  // reasoning. Position-in-list isn't a stable key across refreshes.
  const titleSeen = new Map<string, number>();
  const shelves: Shelf[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items, display } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    const seen = titleSeen.get(title) ?? 0;
    titleSeen.set(title, seen + 1);
    const suffix = seen === 0 ? "" : `-${seen}`;
    shelves.push({
      id: `${cursorTag}-${title}${suffix}`,
      title,
      items,
      display,
    });
  });

  return { shelves, nextCursor };
}

export const fetchExploreFeedPage = (cursor?: string) =>
  fetchBrowseFeedPage(BROWSE_ID.explore, { cursor });

export const fetchChartsFeedPage = (cursor?: string) =>
  fetchBrowseFeedPage(BROWSE_ID.charts, { cursor });

export const fetchNewReleasesFeedPage = (cursor?: string) =>
  fetchBrowseFeedPage(BROWSE_ID.newReleases, { cursor });

export const fetchMoodsAndGenresFeedPage = (cursor?: string) =>
  fetchBrowseFeedPage(BROWSE_ID.moodsAndGenres, { cursor });

// A specific Moods & Genres category — `browseId` is the one carried by
// the navigation tile (e.g. "FEmusic_moods_and_genres_category"), `params`
// is the opaque token from the same tile that selects which category.
export const fetchMoodCategoryFeedPage = (
  browseId: string,
  params: string,
  cursor?: string,
) => fetchBrowseFeedPage(browseId, { params, cursor });

function extractInitialPage(json: YtNode): {
  sections: YtNode[];
  nextCursor?: string;
} {
  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  // Most YTM browse responses have a single tab; Explore (and a few others)
  // ship multiple tabs (Explore / Charts / New releases / Moods & genres) but
  // the *content* of the tab we requested still lands in tabs[0]. The other
  // tabs come back as headers-only with their own browseEndpoint.
  const sectionList = tabs[0]?.tabRenderer?.content?.sectionListRenderer;
  const sections: YtNode[] = sectionList?.contents ?? [];
  const nextCursor =
    findContinuationInContents(sections) ??
    findContinuationInList(sectionList?.continuations);
  return { sections, nextCursor };
}

function extractContinuationPage(json: YtNode): {
  sections: YtNode[];
  nextCursor?: string;
} {
  let sections: YtNode[] = [];
  const actions: YtNode[] = json?.onResponseReceivedActions ?? [];
  for (const a of actions) {
    const items = a?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(items)) sections = sections.concat(items);
  }

  const legacy = json?.continuationContents?.sectionListContinuation;
  if (sections.length === 0 && Array.isArray(legacy?.contents)) {
    sections = legacy.contents;
  }

  const nextCursor =
    findContinuationInContents(sections) ??
    findContinuationInList(legacy?.continuations);
  return { sections, nextCursor };
}

function findContinuationInContents(contents: YtNode[]): string | undefined {
  for (const c of contents) {
    const t =
      c?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;
    if (t) return t;
  }
  return undefined;
}

function findContinuationInList(list?: YtNode[]): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const c of list) {
    const t = c?.nextContinuationData?.continuation;
    if (t) return t;
  }
  return undefined;
}
