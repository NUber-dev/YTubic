import type { PlaylistPage, ShelfItem } from "./types";
import { parseTrackCount } from "./parse-count";
import {
  collectResponsiveRows,
  deepFindThumbnails,
  findContinuationToken,
  mapPlaylistPanelVideo,
  mapResponsiveListItem,
  rawBrowse,
  rawBrowseContinuation,
  rawBrowseReloadContinuation,
  rawNext,
  readRuns,
  readThumbnails,
  type YtNode,
} from "./shared";

/**
 * YTM hides the playlist header under different renderer keys depending
 * on whether the playlist is user-owned (musicEditablePlaylistDetailHeaderRenderer
 * → musicResponsiveHeaderRenderer) or system/community (musicDetailHeaderRenderer
 * → musicResponsiveHeaderRenderer), and where in the response (header,
 * contents.twoColumnBrowseResultsRenderer..., secondaryContents...) the
 * tree puts it. Walk the response and pull the first match instead of
 * enumerating each path.
 */
function extractHeader(json: YtNode): YtNode {
  const HEADER_KEYS = [
    "musicDetailHeaderRenderer",
    "musicResponsiveHeaderRenderer",
  ];
  const seen = new WeakSet<object>();
  let result: YtNode | null = null;
  const walk = (node: unknown) => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    for (const key of HEADER_KEYS) {
      if (n[key] && typeof n[key] === "object") {
        result = n[key];
        return;
      }
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json);
  return result ?? {};
}

/** First node found under the given renderer key, walking the whole tree. */
function findFirstByKey(root: YtNode, key: string): YtNode | undefined {
  const seen = new WeakSet<object>();
  let result: YtNode | undefined;
  const walk = (node: unknown) => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    if (n[key] && typeof n[key] === "object") {
      result = n[key];
      return;
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(root);
  return result;
}

/**
 * Whether the signed-in user owns (and can edit) this playlist. Owned
 * playlists ship editing affordances that community/system ones never
 * do: the editable-header wrapper on older layouts, or an
 * `editPlaylistEndpoint` (header menu's "Edit playlist") on the
 * responsive two-column layout. Any hit means edit_playlist mutations
 * will be accepted.
 */
export function detectEditable(json: YtNode): boolean {
  const EDIT_KEYS = [
    "musicEditablePlaylistDetailHeaderRenderer",
    "editPlaylistEndpoint",
  ];
  const seen = new WeakSet<object>();
  let found = false;
  const walk = (node: unknown) => {
    if (found || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    for (const key of EDIT_KEYS) {
      if (n[key] !== undefined) {
        found = true;
        return;
      }
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json);
  return found;
}

/** The header Shuffle button's watch endpoint, when the playlist has one. */
export type PlaylistShuffle = {
  playlistId: string;
  params: string;
};

/**
 * Pull the shuffle-play endpoint off a playlist browse response. The
 * header's Shuffle button is a `watchPlaylistEndpoint` whose params
 * embed the shufflePlayEndpoint protobuf marker ("8gECKAE"); handing
 * those params to /next returns a server-shuffled queue over the whole
 * playlist (see `fetchShuffleQueue`). Distinct from the header's mix
 * button, which is a `watchPlaylistEndpoint` too but with plain
 * "wAEB" params and an RDAMPL-prefixed id.
 *
 * `requireId` restricts matches to that playlist id — used when walking
 * the full response (rather than just the header) so a stray endpoint
 * on some other rendered entity can't be picked up.
 */
export function extractShuffleEndpoint(
  root: YtNode,
  requireId?: string,
): PlaylistShuffle | undefined {
  const seen = new WeakSet<object>();
  let result: PlaylistShuffle | undefined;
  const walk = (node: unknown) => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    const ep = n.watchPlaylistEndpoint;
    if (
      ep &&
      typeof ep.playlistId === "string" &&
      typeof ep.params === "string" &&
      decodeURIComponent(ep.params).includes("8gECKAE") &&
      (!requireId || ep.playlistId === requireId)
    ) {
      result = { playlistId: ep.playlistId, params: ep.params };
      return;
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(root);
  return result;
}

/**
 * The "Suggestions" shelf YTM appends below an editable playlist:
 * recommended additions, NOT part of the playlist itself. Refreshing via
 * the reload token returns a fresh batch (and a new token).
 */
export type PlaylistSuggestions = {
  tracks: ShelfItem[];
  refreshToken?: string;
};

/** First page plus the continuation pointer for the next one. */
export type PlaylistFirstPage = PlaylistPage & {
  continuationToken?: string;
  /** Server-side shuffle endpoint from the header, when present. */
  shuffle?: PlaylistShuffle;
  /** True when the signed-in user owns the playlist (rows are removable). */
  isEditable?: boolean;
  /** Suggested additions (editable playlists only). */
  suggestions?: PlaylistSuggestions;
};

/** Every subsequent page — only tracks and the next token. */
export type PlaylistNextPage = {
  tracks: ShelfItem[];
  continuationToken?: string;
};

function collectTracks(resp: YtNode, seenIds: Set<string>): ShelfItem[] {
  const out: ShelfItem[] = [];
  for (const row of collectResponsiveRows(resp)) {
    const mapped = mapResponsiveListItem(row);
    if (mapped && mapped.kind === "song" && !seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      out.push(mapped);
    }
  }
  return out;
}

/** Rows + reload token from a suggestions shelf (renderer or continuation). */
function parseSuggestionsShelf(shelf: YtNode): PlaylistSuggestions {
  const tracks: ShelfItem[] = [];
  for (const row of collectResponsiveRows(shelf.contents ?? [])) {
    const mapped = mapResponsiveListItem(row);
    if (mapped && mapped.kind === "song") tracks.push(mapped);
  }
  return {
    tracks,
    refreshToken:
      shelf.continuations?.[0]?.reloadContinuationData?.continuation,
  };
}

/**
 * Find the Suggestions shelf in a playlist browse response. It's the
 * musicShelfRenderer carrying a RELOAD continuation — the playlist's own
 * rows live in musicPlaylistShelfRenderer (with a next-continuation), so
 * this can never match them.
 */
export function extractSuggestions(
  json: YtNode,
): PlaylistSuggestions | undefined {
  const seen = new WeakSet<object>();
  let result: PlaylistSuggestions | undefined;
  const walk = (node: unknown) => {
    if (result || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    const shelf = n.musicShelfRenderer;
    if (shelf?.continuations?.[0]?.reloadContinuationData?.continuation) {
      result = parseSuggestionsShelf(shelf);
      return;
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json);
  return result;
}

/** Fetch a fresh batch of suggestions via the shelf's reload token. */
export async function fetchPlaylistSuggestions(
  token: string,
): Promise<PlaylistSuggestions> {
  const json = await rawBrowseReloadContinuation(token);
  const shelf = json?.continuationContents?.musicShelfContinuation;
  if (shelf) return parseSuggestionsShelf(shelf);
  // Newer layouts answer continuations with onResponseReceivedActions
  // instead of continuationContents — sweep rows and the new reload
  // token from the whole envelope.
  const tracks: ShelfItem[] = [];
  for (const row of collectResponsiveRows(json)) {
    const mapped = mapResponsiveListItem(row);
    if (mapped && mapped.kind === "song") tracks.push(mapped);
  }
  return {
    tracks,
    refreshToken: findFirstByKey(json, "reloadContinuationData")?.continuation,
  };
}

/**
 * Fetch a playlist's header + first ~100 tracks. Subsequent pages are
 * loaded lazily via `fetchPlaylistContinuation` as the user scrolls —
 * this keeps first-paint fast and matches how the real YT Music web
 * client paginates long playlists.
 */
export async function fetchPlaylistFirstPage(
  id: string,
): Promise<PlaylistFirstPage> {
  const browseId = id.startsWith("VL") ? id : `VL${id}`;
  const rawId = browseId.slice(2);
  const json = await rawBrowse(browseId);

  if (import.meta.env.DEV) {
    console.debug("[playlist] browse response", browseId, json);
  }

  const header = extractHeader(json);
  const title = readRuns(header.title);
  const description = readRuns(header.description);
  let thumbnails = readThumbnails(
    header.thumbnail?.musicThumbnailRenderer?.thumbnail ??
      header.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail ??
      header.thumbnail?.musicThumbnailRenderer ??
      header.thumbnail,
  );
  if (thumbnails.length === 0) {
    thumbnails = deepFindThumbnails(header.thumbnail);
  }
  const subtitleText = readRuns(header.subtitle);
  const secondText = readRuns(header.secondSubtitle);
  const trackCount = parseTrackCount(secondText);

  // Header first; fall back to the full response (id-restricted) for
  // layouts that keep the buttons outside the header renderer.
  const shuffle =
    extractShuffleEndpoint(header) ?? extractShuffleEndpoint(json, rawId);

  // Scope track collection to the playlist's own shelf. Editable
  // playlists append a "Suggestions" musicShelfRenderer to the same
  // section list — walking the whole response used to sweep those
  // suggested rows into the playlist as if they were members.
  const playlistShelf = findFirstByKey(json, "musicPlaylistShelfRenderer");
  const trackScope = playlistShelf ?? json;
  const seenIds = new Set<string>();
  let tracks = collectTracks(trackScope, seenIds);
  let continuationToken = findContinuationToken(trackScope);
  let suggestions = extractSuggestions(json);
  if (!suggestions && playlistShelf) {
    // Suggestions shelf in a shape we don't recognize: whatever song rows
    // sit OUTSIDE the playlist shelf are suggestion rows (the playlist's
    // own are already in seenIds). No refresh token in this path, so the
    // UI simply hides its Refresh button.
    const stray = collectTracks(json, seenIds);
    if (stray.length > 0) suggestions = { tracks: stray };
  }

  // Fallback: "radio-style" community playlists (RDCLAK5..., RDAMPL...,
  // RDAT...) are computed lazily — /browse returns only a header, and
  // tracks live under /next. Radio playlists are short (~25 tracks) so
  // there's no continuation to follow.
  if (tracks.length === 0) {
    try {
      const nextJson = await rawNext({
        playlistId: rawId,
        isAudioOnly: true,
      });
      const panelContents: YtNode[] =
        nextJson?.contents?.singleColumnMusicWatchNextResultsRenderer
          ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
          ?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents ?? [];
      const radioTracks: ShelfItem[] = [];
      for (const c of panelContents) {
        // Unwrap playlistPanelVideoWrapperRenderer (song+MV rows) too.
        const row =
          c.playlistPanelVideoRenderer ??
          c.playlistPanelVideoWrapperRenderer?.primaryRenderer
            ?.playlistPanelVideoRenderer;
        if (!row) continue;
        const mapped = mapPlaylistPanelVideo(row);
        if (mapped) radioTracks.push(mapped);
      }
      tracks = radioTracks;
      continuationToken = undefined;
    } catch (e) {
      if (import.meta.env.DEV) {
        console.debug("[playlist] /next fallback failed:", e);
      }
    }
  }

  return {
    id: browseId,
    title,
    description: description || undefined,
    owner: subtitleText || undefined,
    trackCount,
    thumbnails,
    tracks,
    continuationToken,
    shuffle,
    isEditable: detectEditable(json),
    suggestions,
  };
}

/**
 * Fetch the next page of a playlist given a continuation token from a
 * previous response. The token is single-use — callers should persist
 * the *new* token returned alongside the tracks.
 */
export async function fetchPlaylistContinuation(
  token: string,
): Promise<PlaylistNextPage> {
  const json = await rawBrowseContinuation(token);
  const tracks = collectTracks(json, new Set());
  const next = findContinuationToken(json);
  return {
    tracks,
    continuationToken: next === token ? undefined : next,
  };
}

/**
 * Full-load variant: walks every continuation and returns the entire
 * playlist in one shot. Kept for callers that genuinely need the whole
 * list (e.g. the liked-songs membership cache used to decide whether a
 * track shows a filled thumb-up), not for UI rendering of long lists.
 */
export async function fetchPlaylist(id: string): Promise<PlaylistPage> {
  const first = await fetchPlaylistFirstPage(id);
  const tracks = [...first.tracks];
  const seenIds = new Set(tracks.map((t) => t.id));
  let token = first.continuationToken;
  for (let i = 0; token && i < 200; i++) {
    let page: PlaylistNextPage;
    try {
      page = await fetchPlaylistContinuation(token);
    } catch (e) {
      if (import.meta.env.DEV) {
        console.debug("[playlist] continuation failed:", e);
      }
      break;
    }
    const before = tracks.length;
    for (const t of page.tracks) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        tracks.push(t);
      }
    }
    if (tracks.length === before) break;
    token = page.continuationToken;
  }
  if (import.meta.env.DEV) {
    console.debug("[playlist] full-load parsed:", id, "tracks=", tracks.length);
  }
  const { continuationToken: _drop, ...meta } = first;
  void _drop;
  return { ...meta, tracks };
}
