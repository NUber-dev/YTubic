import { describe, expect, it } from "vitest";
import { albumIdFromWatchNext } from "./album";
import type { YtNode } from "./shared";

function watchNext(rows: YtNode[]): YtNode {
  return {
    contents: {
      singleColumnMusicWatchNextResultsRenderer: {
        tabbedRenderer: {
          watchNextTabbedResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    musicQueueRenderer: {
                      content: {
                        playlistPanelRenderer: {
                          contents: rows,
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}

describe("albumIdFromWatchNext", () => {
  it("returns the matching row's album browse id", () => {
    const json = watchNext([
      {
        playlistPanelVideoRenderer: {
          title: { runs: [{ text: "Song" }] },
          navigationEndpoint: { watchEndpoint: { videoId: "vid1" } },
          longBylineText: {
            runs: [
              {
                text: "Album",
                navigationEndpoint: { browseEndpoint: { browseId: "MPREb_one" } },
              },
            ],
          },
        },
      },
      {
        playlistPanelVideoRenderer: {
          title: { runs: [{ text: "Other" }] },
          navigationEndpoint: { watchEndpoint: { videoId: "vid2" } },
          longBylineText: {
            runs: [
              {
                text: "Other Album",
                navigationEndpoint: { browseEndpoint: { browseId: "MPREb_two" } },
              },
            ],
          },
        },
      },
    ]);
    expect(albumIdFromWatchNext(json, "vid2")).toBe("MPREb_two");
  });

  it("does not use a neighbor row's album", () => {
    const json = watchNext([
      {
        playlistPanelVideoRenderer: {
          title: { runs: [{ text: "Single" }] },
          navigationEndpoint: { watchEndpoint: { videoId: "vid1" } },
          longBylineText: { runs: [{ text: "Artist" }] },
        },
      },
      {
        playlistPanelVideoRenderer: {
          title: { runs: [{ text: "Album track" }] },
          navigationEndpoint: { watchEndpoint: { videoId: "vid2" } },
          longBylineText: {
            runs: [
              {
                text: "Album",
                navigationEndpoint: { browseEndpoint: { browseId: "MPREb_x" } },
              },
            ],
          },
        },
      },
    ]);
    expect(albumIdFromWatchNext(json, "vid1")).toBeUndefined();
  });
});
