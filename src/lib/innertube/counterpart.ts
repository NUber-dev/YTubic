import { rawNext, type YtNode } from "./shared";

/** YT Music's own song/video pairing, when it exposes one. */
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
