import type { AlbumPage, MinimalArtist, ShelfItem } from "./types";
import { parseTrackCount } from "./parse-count";
import {
  collectResponsiveRows,
  mapPlaylistPanelVideo,
  mapResponsiveListItem,
  rawBrowse,
  rawNext,
  readRuns,
  readThumbnails,
  type YtNode,
} from "./shared";

/** Pull the watch-next playlist panel out of a `/next` response. */
function watchNextPanel(json: YtNode): YtNode | undefined {
  return (
    json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer ??
    json?.continuationContents?.playlistPanelContinuation
  );
}

/**
 * Album browse id for `videoId` from a `/next` payload. Matches the
 * current-track row first; does not fall back to a neighbor's album.
 */
export function albumIdFromWatchNext(
  json: YtNode,
  videoId: string,
): string | undefined {
  const panel = watchNextPanel(json);
  for (const c of (panel?.contents as YtNode[] | undefined) ?? []) {
    const row =
      c.playlistPanelVideoRenderer ??
      c.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;
    if (!row) continue;
    const mapped = mapPlaylistPanelVideo(row);
    if (mapped?.id === videoId && mapped.albumId) return mapped.albumId;
  }
  return undefined;
}

/**
 * Look up the album browse id for a playing video. Used when the queue
 * item was built from a row that didn't carry an album link (radio,
 * home, persisted queues).
 */
export async function fetchAlbumIdForVideo(
  videoId: string,
): Promise<string | undefined> {
  const json = await rawNext({
    videoId,
    isAudioOnly: true,
    enablePersistentPlaylistPanel: true,
  });
  return albumIdFromWatchNext(json, videoId);
}

function extractAlbumHeader(json: YtNode): YtNode {
  return (
    json?.header?.musicDetailHeaderRenderer ??
    json?.header?.musicResponsiveHeaderRenderer ??
    json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents?.[0]
      ?.musicResponsiveHeaderRenderer ??
    {}
  );
}

export async function fetchAlbum(id: string): Promise<AlbumPage> {
  const json = await rawBrowse(id);

  if (import.meta.env.DEV) {
    console.debug("[album] browse response", id, json);
  }

  const header = extractAlbumHeader(json);

  const title = readRuns(header.title);
  const thumbnails = readThumbnails(
    header.thumbnail?.musicThumbnailRenderer?.thumbnail ??
      header.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail ??
      header.thumbnail?.musicThumbnailRenderer ??
      header.thumbnail,
  );

  // Subtitle typically: "Album • Artist • 2024" (single column) or split
  // across `straplineTextOne` + `subtitle` runs in the responsive header.
  const subtitleRuns: YtNode[] = [
    ...((header.subtitle?.runs ?? []) as YtNode[]),
    ...((header.straplineTextOne?.runs ?? []) as YtNode[]),
  ];
  const artists: MinimalArtist[] = [];
  let year: string | undefined;
  for (const run of subtitleRuns) {
    const browseId = run.navigationEndpoint?.browseEndpoint?.browseId as
      | string
      | undefined;
    const pageType = run.navigationEndpoint?.browseEndpoint
      ?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType as string | undefined;
    if (browseId && pageType?.includes("ARTIST")) {
      artists.push({ id: browseId, name: run.text ?? "" });
    } else if (/^\d{4}$/.test((run.text ?? "").trim())) {
      year = run.text.trim();
    }
  }

  const secondSubtitleRuns: YtNode[] = header.secondSubtitle?.runs ?? [];
  const secondText = secondSubtitleRuns
    .map((r) => r.text ?? "")
    .join("")
    .trim();
  // "12 songs • 45 minutes"
  const trackCount = parseTrackCount(secondText);
  const durationMatch = secondText.split("•")[1]?.trim();

  // Walk the whole response. Album layouts vary (singleColumn vs
  // twoColumn, musicShelfRenderer vs musicPlaylistShelfRenderer wrapper)
  // but the row renderer is always the same, so a tree walk is robust.
  const seenIds = new Set<string>();
  const tracks: ShelfItem[] = [];
  for (const row of collectResponsiveRows(json)) {
    const mapped = mapResponsiveListItem(row);
    if (mapped && mapped.kind === "song" && !seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      // Album-page rows rarely carry their own album browse link (the
      // user is already on the album), so stamp the page id/title onto
      // each track. That lets "Go to album" and Last.fm scrobbles work
      // after the user queues from this page.
      tracks.push({
        ...mapped,
        album: mapped.album ?? title,
        albumId: mapped.albumId ?? id,
      });
    }
  }

  return {
    id,
    title,
    artists,
    year,
    trackCount,
    duration: durationMatch,
    thumbnails,
    tracks,
  };
}
