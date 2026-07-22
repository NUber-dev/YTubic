import { describe, expect, it } from "vitest";
import {
  detectEditable,
  extractShuffleEndpoint,
  extractSuggestions,
} from "./playlist";
import type { YtNode } from "./shared";

// Shapes lifted from a real playlist browse header: the Shuffle button's
// watchPlaylistEndpoint params carry the "8gECKAE" shuffle marker, while
// the mix button is a watchPlaylistEndpoint too but with plain "wAEB"
// params and an RDAMPL-prefixed id.
function header(): YtNode {
  return {
    buttons: [
      {
        musicPlayButtonRenderer: {
          playNavigationEndpoint: {
            watchEndpoint: {
              videoId: "abc123",
              playlistId: "PLxyz",
              params: "wAEB",
            },
          },
        },
      },
      {
        menuRenderer: {
          items: [
            {
              menuNavigationItemRenderer: {
                navigationEndpoint: {
                  watchPlaylistEndpoint: {
                    playlistId: "RDAMPLPLxyz",
                    params: "wAEB",
                  },
                },
              },
            },
          ],
          topLevelButtons: [
            {
              buttonRenderer: {
                navigationEndpoint: {
                  watchPlaylistEndpoint: {
                    playlistId: "PLxyz",
                    params: "wAEB8gECKAE%3D",
                  },
                },
              },
            },
          ],
        },
      },
    ],
  };
}

describe("extractShuffleEndpoint", () => {
  it("finds the shuffle watchPlaylistEndpoint by its params marker", () => {
    expect(extractShuffleEndpoint(header())).toEqual({
      playlistId: "PLxyz",
      params: "wAEB8gECKAE%3D",
    });
  });

  it("ignores the mix button and plain watchEndpoints", () => {
    const h = header();
    // Drop the shuffle button, leaving only play + mix endpoints.
    (h.buttons[1].menuRenderer as YtNode).topLevelButtons = [];
    expect(extractShuffleEndpoint(h)).toBeUndefined();
  });

  it("restricts matches to the given playlist id when requireId is set", () => {
    expect(extractShuffleEndpoint(header(), "PLother")).toBeUndefined();
    expect(extractShuffleEndpoint(header(), "PLxyz")).toEqual({
      playlistId: "PLxyz",
      params: "wAEB8gECKAE%3D",
    });
  });

  it("accepts already-decoded params too", () => {
    const h: YtNode = {
      watchPlaylistEndpoint: { playlistId: "LM", params: "wAEB8gECKAE=" },
    };
    expect(extractShuffleEndpoint(h)).toEqual({
      playlistId: "LM",
      params: "wAEB8gECKAE=",
    });
  });
});

describe("detectEditable", () => {
  it("detects the legacy editable-header wrapper", () => {
    expect(
      detectEditable({
        header: {
          musicEditablePlaylistDetailHeaderRenderer: {
            header: { musicResponsiveHeaderRenderer: {} },
          },
        },
      }),
    ).toBe(true);
  });

  it("detects the responsive layout's Edit playlist menu endpoint", () => {
    expect(
      detectEditable({
        contents: {
          menu: {
            menuRenderer: {
              items: [
                {
                  menuNavigationItemRenderer: {
                    navigationEndpoint: {
                      editPlaylistEndpoint: { playlistId: "PLxyz" },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("reports community/system playlists as not editable", () => {
    expect(
      detectEditable({
        header: { musicDetailHeaderRenderer: { title: {} } },
        contents: { rows: [{ watchEndpoint: { videoId: "abc" } }] },
      }),
    ).toBe(false);
  });
});

// A minimal song row the responsive-list parser accepts: title + watch
// endpoint in the first flex column, optional playlistItemData.
function songRow(videoId: string, title: string, setVideoId?: string): YtNode {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: title,
                  navigationEndpoint: { watchEndpoint: { videoId } },
                },
              ],
            },
          },
        },
      ],
      ...(setVideoId
        ? { playlistItemData: { videoId, playlistSetVideoId: setVideoId } }
        : {}),
    },
  };
}

describe("extractSuggestions", () => {
  const response = (): YtNode => ({
    contents: {
      sectionListRenderer: {
        contents: [
          {
            musicPlaylistShelfRenderer: {
              contents: [songRow("own1", "In the playlist", "SET1")],
              continuations: [
                { nextContinuationData: { continuation: "next-token" } },
              ],
            },
          },
          {
            musicShelfRenderer: {
              contents: [
                songRow("sug1", "Suggested one"),
                songRow("sug2", "Suggested two"),
              ],
              continuations: [
                { reloadContinuationData: { continuation: "reload-token" } },
              ],
            },
          },
        ],
      },
    },
  });

  it("returns only the reload-continuation shelf's rows plus its token", () => {
    const s = extractSuggestions(response());
    expect(s).toBeDefined();
    expect(s!.tracks.map((t) => t.id)).toEqual(["sug1", "sug2"]);
    expect(s!.refreshToken).toBe("reload-token");
  });

  it("ignores plain shelves without a reload continuation", () => {
    const r = response();
    const shelf = (r.contents.sectionListRenderer.contents[1] as YtNode)
      .musicShelfRenderer as YtNode;
    shelf.continuations = [
      { nextContinuationData: { continuation: "next-token" } },
    ];
    expect(extractSuggestions(r)).toBeUndefined();
  });
});
