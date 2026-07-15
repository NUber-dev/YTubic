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

/** First page plus the continuation pointer for the next one. */
export type PlaylistFirstPage = PlaylistPage & {
  continuationToken?: string;
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

/**
 * The playlist's OWN track shelf. YTM appends a "Suggestions" section to
 * editable playlists whose rows use the exact same renderer as saved
 * tracks, and on a short playlist the suggestions shelf is the only one
 * carrying a continuation. Walking the whole response therefore swallows
 * recommendations as if they were playlist members (a 6-track playlist
 * rendering 13, then growing on scroll). Scope row collection and the
 * continuation pointer to this shelf; when a response genuinely has no
 * playlist shelf (radio-style lists handled by the /next fallback), the
 * caller falls back to the whole-response walk.
 */
function findPlaylistShelf(json: YtNode): YtNode | null {
  const SHELF_KEYS = [
    "musicPlaylistShelfRenderer",
    "musicPlaylistShelfContinuation",
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
    for (const key of SHELF_KEYS) {
      if (n[key] && typeof n[key] === "object") {
        result = n[key];
        return;
      }
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json);
  return result;
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

  const shelf = findPlaylistShelf(json);
  const trackScope = shelf ?? json;
  const seenIds = new Set<string>();
  let tracks = collectTracks(trackScope, seenIds);
  let continuationToken = findContinuationToken(trackScope);

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
  // Same scoping as the first page: a continuation response can carry a
  // trailing suggestions section too.
  const scope = findPlaylistShelf(json) ?? json;
  const tracks = collectTracks(scope, new Set());
  const next = findContinuationToken(scope);
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
