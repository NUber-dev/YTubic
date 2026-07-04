import type { ShelfItem } from "./types";
import { mapPlaylistPanelVideo, rawNext, type YtNode } from "./shared";

/**
 * Fetch a radio station seeded on a single videoId.
 * Equivalent to what YTM does when you click "Start radio" — /next with
 * playlistId `RDAMVM<videoId>` gives back a `playlistPanelRenderer` full
 * of similar tracks.
 *
 * Returns the seed track followed by ~24 recommended tracks.
 */
export async function fetchRadio(videoId: string): Promise<ShelfItem[]> {
  const json = await rawNext({
    videoId,
    playlistId: `RDAMVM${videoId}`,
    isAudioOnly: true,
  });

  const panelContents: YtNode[] =
    json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? [];

  const tracks: ShelfItem[] = [];
  for (const c of panelContents) {
    // YTM wraps rows that have both a song and a music-video version in a
    // playlistPanelVideoWrapperRenderer; the real row is under primaryRenderer.
    const row =
      c.playlistPanelVideoRenderer ??
      c.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer;
    if (!row) continue;
    const mapped = mapPlaylistPanelVideo(row);
    if (mapped) tracks.push(mapped);
  }

  if (import.meta.env.DEV) {
    console.debug("[radio] seed=", videoId, "tracks=", tracks.length);
  }

  return tracks;
}
