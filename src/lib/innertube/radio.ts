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
/** Pull the queue rows out of a /next `playlistPanelRenderer` response. */
function parsePanelTracks(json: YtNode): ShelfItem[] {
  const panelContents: YtNode[] =
    json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? [];

  const tracks: ShelfItem[] = [];
  for (const c of panelContents) {
    // YTM wraps rows that have both a song and a music-video version in a
    // playlistPanelVideoWrapperRenderer; the shown row is under
    // primaryRenderer and the other version rides along under
    // counterpart[].counterpartRenderer.
    const wrapper = c.playlistPanelVideoWrapperRenderer;
    const row =
      c.playlistPanelVideoRenderer ??
      wrapper?.primaryRenderer?.playlistPanelVideoRenderer;
    if (!row) continue;
    const mapped = mapPlaylistPanelVideo(row);
    if (!mapped) continue;
    // Pull the counterpart's id so the Source toggle can flip to the real
    // other version. This is YT's own song<->video pairing, so it's the
    // same track, unlike a fuzzy search which can land on a different one.
    const counterpartId: string | undefined =
      wrapper?.counterpart?.[0]?.counterpartRenderer?.playlistPanelVideoRenderer
        ?.navigationEndpoint?.watchEndpoint?.videoId;
    if (counterpartId && counterpartId !== mapped.id) {
      mapped.counterpartId = counterpartId;
    }
    tracks.push(mapped);
  }
  return tracks;
}

/**
 * Authoritative duration for a single video, read from its own /next
 * panel row. Used for tracks queued off surfaces that don't carry a
 * length (home cards) — without a metadata length the doubled-header
 * clamp in the audio engine has no reference and a 2x file plays out
 * at twice its real length.
 */
export async function fetchPanelDuration(
  videoId: string,
): Promise<number | undefined> {
  const tracks = parsePanelTracks(
    await rawNext({ videoId, isAudioOnly: true }),
  );
  const hit = tracks.find((t) => t.id === videoId);
  return hit?.duration;
}

export async function fetchRadio(videoId: string): Promise<ShelfItem[]> {
  const tracks = parsePanelTracks(
    await rawNext({
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
    }),
  );
  if (import.meta.env.DEV) {
    console.debug("[radio] seed=", videoId, "tracks=", tracks.length);
  }
  return tracks;
}

/**
 * Build a play queue from a watch-playlist id — the kind the search
 * top-result card's Shuffle / Play button hands us: an artist shuffle
 * radio (`RDAO…`), an album (`OLAK…`), or a community playlist (`VL…` /
 * `RDCLAK…`). /next expands it into a `playlistPanelRenderer` of tracks.
 */
export async function fetchWatchQueue(
  playlistId: string,
  videoId?: string,
): Promise<ShelfItem[]> {
  const body: Record<string, unknown> = { playlistId, isAudioOnly: true };
  if (videoId) body.videoId = videoId;
  return parsePanelTracks(await rawNext(body));
}
