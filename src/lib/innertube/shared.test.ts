import { describe, expect, it } from "vitest";
import {
  albumBrowseIdFromEndpoint,
  mapPlaylistPanelVideo,
  mapResponsiveListItem,
  mapShelfWrapper,
  splitSetCookieHeader,
  type YtNode,
} from "./shared";

// Fallback splitter for runtimes without Headers.getSetCookie. The
// tricky part is NOT splitting on the comma inside an Expires date.
describe("splitSetCookieHeader", () => {
  it("returns [] for an empty header", () => {
    expect(splitSetCookieHeader("")).toEqual([]);
  });

  it("keeps a single cookie with an Expires date intact", () => {
    const raw =
      "SIDCC=AKEy_abc123; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Path=/; Domain=.youtube.com; Secure";
    expect(splitSetCookieHeader(raw)).toEqual([raw]);
  });

  it("splits two cookies joined with a comma", () => {
    const a =
      "SIDCC=AKEy_abc; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Domain=.youtube.com; Path=/";
    const b =
      "LOGIN_INFO=AFmmF2s:QUQ3; Expires=Thu, 06 Jul 2028 18:24:08 GMT; Domain=.youtube.com; Path=/; Secure; HttpOnly";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });

  it("handles __Secure- prefixed names after the comma", () => {
    const a = "SIDCC=v1; Domain=.youtube.com; Path=/";
    const b = "__Secure-3PSIDCC=v2; Domain=.youtube.com; Path=/; Secure";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });
});

// Shelf "More" endpoint extraction — shapes observed live on artist
// pages 2026-07-12: carousels carry it in the header's moreContentButton,
// the Top-songs musicShelfRenderer in bottomEndpoint / the title run.
describe("mapShelfWrapper more endpoint", () => {
  const browse = (browseId: string, params?: string, pageType?: string) => ({
    browseEndpoint: {
      browseId,
      params,
      browseEndpointContextSupportedConfigs: {
        browseEndpointContextMusicConfig: { pageType },
      },
    },
  });

  const twoRowItem: YtNode = {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: "Album X" }] },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: "MPREb_x",
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: "MUSIC_PAGE_TYPE_ALBUM",
            },
          },
        },
      },
    },
  };

  it("reads moreContentButton off a carousel header", () => {
    const wrapper: YtNode = {
      musicCarouselShelfRenderer: {
        header: {
          musicCarouselShelfBasicHeaderRenderer: {
            title: { runs: [{ text: "Albums" }] },
            moreContentButton: {
              buttonRenderer: {
                navigationEndpoint: browse(
                  "MPADUC_a",
                  "ggMI",
                  "MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY",
                ),
              },
            },
          },
        },
        contents: [twoRowItem],
      },
    };
    const { more } = mapShelfWrapper(wrapper, 0);
    expect(more).toEqual({
      browseId: "MPADUC_a",
      params: "ggMI",
      pageType: "MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY",
    });
  });

  it("falls back to the title run's navigationEndpoint on a musicShelfRenderer", () => {
    const wrapper: YtNode = {
      musicShelfRenderer: {
        title: {
          runs: [
            {
              text: "Top songs",
              navigationEndpoint: browse(
                "VLOLAK_top",
                "ggMCCAI%3D",
                "MUSIC_PAGE_TYPE_PLAYLIST",
              ),
            },
          ],
        },
        contents: [twoRowItem],
      },
    };
    const { more } = mapShelfWrapper(wrapper, 0);
    expect(more?.browseId).toBe("VLOLAK_top");
    expect(more?.pageType).toBe("MUSIC_PAGE_TYPE_PLAYLIST");
  });

  it("returns undefined when the shelf has no more endpoint", () => {
    const wrapper: YtNode = {
      musicCarouselShelfRenderer: {
        header: {
          musicCarouselShelfBasicHeaderRenderer: {
            title: { runs: [{ text: "Fans might also like" }] },
          },
        },
        contents: [twoRowItem],
      },
    };
    expect(mapShelfWrapper(wrapper, 0).more).toBeUndefined();
  });
});

describe("album browse id extraction", () => {
  it("treats MPREb_ as an album even without pageType", () => {
    expect(
      albumBrowseIdFromEndpoint({
        browseEndpoint: { browseId: "MPREb_abc" },
      }),
    ).toBe("MPREb_abc");
  });

  it("ignores artist channels", () => {
    expect(
      albumBrowseIdFromEndpoint({
        browseEndpoint: {
          browseId: "UCxyz",
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: "MUSIC_PAGE_TYPE_ARTIST",
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("maps a panel video album from a byline without pageType", () => {
    const item = mapPlaylistPanelVideo({
      title: { runs: [{ text: "Song" }] },
      navigationEndpoint: { watchEndpoint: { videoId: "vid1" } },
      longBylineText: {
        runs: [
          { text: "Artist" },
          { text: " • " },
          {
            text: "The Album",
            navigationEndpoint: { browseEndpoint: { browseId: "MPREb_x" } },
          },
        ],
      },
    });
    expect(item).toMatchObject({
      id: "vid1",
      album: "The Album",
      albumId: "MPREb_x",
    });
  });

  it("maps a panel video album from the overflow menu", () => {
    const item = mapPlaylistPanelVideo({
      title: { runs: [{ text: "Song" }] },
      navigationEndpoint: { watchEndpoint: { videoId: "vid1" } },
      longBylineText: { runs: [{ text: "Artist" }] },
      menu: {
        menuRenderer: {
          items: [
            {
              menuNavigationItemRenderer: {
                text: { runs: [{ text: "Go to album" }] },
                navigationEndpoint: {
                  browseEndpoint: { browseId: "MPREb_from_menu" },
                },
              },
            },
          ],
        },
      },
    });
    expect(item?.albumId).toBe("MPREb_from_menu");
  });

  it("maps a list-row album from the overflow menu", () => {
    const item = mapResponsiveListItem({
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: "Song",
                  navigationEndpoint: { watchEndpoint: { videoId: "vid1" } },
                },
              ],
            },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: "Artist" }] },
          },
        },
      ],
      menu: {
        menuRenderer: {
          items: [
            {
              menuNavigationItemRenderer: {
                navigationEndpoint: {
                  browseEndpoint: {
                    browseId: "MPREb_row",
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: {
                        pageType: "MUSIC_PAGE_TYPE_ALBUM",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(item).toMatchObject({ id: "vid1", albumId: "MPREb_row" });
  });
});
