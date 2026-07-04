import type { ArtistPage, Shelf } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
  readRuns,
  readThumbnails,
  type YtNode,
} from "./shared";

export async function fetchArtist(id: string): Promise<ArtistPage> {
  const json = await rawBrowse(id);

  const header =
    json?.header?.musicImmersiveHeaderRenderer ??
    json?.header?.musicDetailHeaderRenderer ??
    {};

  const name = readRuns(header.title);
  const description = readRuns(header.description);
  const subscribers = readRuns(header.subscriptionButton
    ?.subscribeButtonRenderer?.subscriberCountText ?? header.subtitle);
  const thumbnails = readThumbnails(
    header.thumbnail?.musicThumbnailRenderer?.thumbnail ??
      header.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail ??
      header.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail,
  );

  const radioId: string | undefined =
    header.startRadioButton?.buttonRenderer?.navigationEndpoint?.watchEndpoint
      ?.videoId;
  const shuffleId: string | undefined =
    header.playButton?.buttonRenderer?.navigationEndpoint?.watchPlaylistEndpoint
      ?.playlistId ??
    header.playButton?.buttonRenderer?.navigationEndpoint?.watchEndpoint
      ?.videoId;

  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const sections: YtNode[] =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const shelfNodes = collectShelfNodes(sections);

  const shelves: Shelf[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items, display } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    shelves.push({ id: `${title}-${i}`, title, items, display });
  });

  return {
    id,
    name,
    description: description || undefined,
    subscribers: subscribers || undefined,
    thumbnails,
    radioId,
    shuffleId,
    shelves,
  };
}
