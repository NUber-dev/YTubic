import { rawNext, type YtNode } from "./shared";

/**
 * The videoId YT Music itself pairs with `videoId` for the Song/Video
 * switch in its own player. /next wraps a track that exists in both forms
 * in a `playlistPanelVideoWrapperRenderer`: `primaryRenderer` is the form
 * that was asked for, `counterpart` is the other one.
 *
 * Authoritative wherever it exists, and it is the only thing that finds a
 * pairing whose two titles share no words at all: VALORANT's "Toxic" is
 * published as the music video "WHY WE FIGHT BACK", which no amount of
 * title or artist matching against the search results can reach.
 */
export async function fetchCounterpartVideoId(
  videoId: string,
): Promise<string | null> {
  try {
    const json = await rawNext({
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: false,
    });
    const panel: YtNode | undefined =
      json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.musicQueueRenderer?.content?.playlistPanelRenderer;
    for (const row of (panel?.contents as YtNode[] | undefined) ?? []) {
      const wrapper = row.playlistPanelVideoWrapperRenderer;
      if (!wrapper) continue;
      const primaryId =
        wrapper.primaryRenderer?.playlistPanelVideoRenderer?.videoId;
      if (primaryId && primaryId !== videoId) continue;
      for (const alt of (wrapper.counterpart as YtNode[] | undefined) ?? []) {
        const id = alt.counterpartRenderer?.playlistPanelVideoRenderer?.videoId;
        if (typeof id === "string" && id && id !== videoId) return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}
