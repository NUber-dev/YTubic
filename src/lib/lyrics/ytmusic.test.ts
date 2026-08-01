import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fixtures mirror responses captured from the live InnerTube API, not
 * invented shapes: the timed rows, the string-typed millisecond fields and
 * the bare-note interlude are all as YTM actually sends them.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const LYRICS_BROWSE_ID = "MPLYt_4U7yfKKFZLv-1";

function tab(opts: {
  pageType?: string;
  title?: string;
  browseId?: string;
  unselectable?: boolean;
}) {
  return {
    tabRenderer: {
      title: opts.title ?? "Lyrics",
      ...(opts.unselectable === undefined
        ? {}
        : { unselectable: opts.unselectable }),
      endpoint: {
        browseEndpoint: {
          browseId: opts.browseId ?? LYRICS_BROWSE_ID,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: opts.pageType ?? "MUSIC_PAGE_TYPE_TRACK_LYRICS",
            },
          },
        },
      },
    },
  };
}

function nextResponse(tabs: unknown[]) {
  return {
    contents: {
      singleColumnMusicWatchNextResultsRenderer: {
        tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs } },
      },
    },
  };
}

const TIMED_ROWS = [
  {
    lyricLine: "♪",
    cueRange: {
      startTimeMilliseconds: "0",
      endTimeMilliseconds: "13570",
      metadata: { id: "0" },
    },
  },
  {
    lyricLine: "I've been tryna call",
    cueRange: {
      startTimeMilliseconds: "13570",
      endTimeMilliseconds: "16110",
      metadata: { id: "1" },
    },
  },
  {
    lyricLine: "I've been on my own for long enough",
    cueRange: {
      startTimeMilliseconds: "16110",
      endTimeMilliseconds: "19200",
      metadata: { id: "2" },
    },
  },
  // Attribution rides along with no cueRange.
  { lyricLine: "Source: Musixmatch" },
];

const timedBrowse = {
  contents: {
    elementRenderer: {
      newElement: {
        type: {
          componentType: {
            model: { timedLyricsModel: { lyricsData: { timedLyricsData: TIMED_ROWS } } },
          },
        },
      },
    },
  },
};

const plainBrowse = {
  contents: {
    sectionListRenderer: {
      contents: [
        {
          musicDescriptionShelfRenderer: {
            description: { runs: [{ text: "Yeah\n\nI've been tryna call" }] },
            footer: { runs: [{ text: "Source: Musixmatch" }] },
          },
        },
      ],
    },
  },
};

const noLyricsBrowse = {
  contents: {
    messageRenderer: { text: { runs: [{ text: "Lyrics not available" }] } },
  },
};

type Call = { url: string; body: Record<string, unknown> };

async function setup(route: (url: string) => unknown, status = 200) {
  vi.resetModules();
  const http = await import("@tauri-apps/plugin-http");
  const fetchMock = vi.mocked(http.fetch);
  fetchMock.mockReset();
  const calls: Call[] = [];
  fetchMock.mockImplementation((input: unknown, init?: unknown) => {
    const url = String(input);
    const raw = (init as { body?: string } | undefined)?.body;
    calls.push({ url, body: raw ? JSON.parse(raw) : {} });
    return Promise.resolve(
      new Response(JSON.stringify(route(url)), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const { fetchYtMusicLyrics } = await import("./ytmusic");
  return { fetchYtMusicLyrics, calls };
}

const bothHops = (next: unknown, browse: unknown) => (url: string) =>
  url.includes("/next") ? next : browse;

beforeEach(() => vi.clearAllMocks());

describe("YouTube Music lyrics", () => {
  it("returns line-synced lyrics with seconds, not milliseconds", async () => {
    const { fetchYtMusicLyrics } = await setup(
      bothHops(nextResponse([tab({})]), timedBrowse),
    );
    const res = await fetchYtMusicLyrics("J7p4bzqLvCw");
    expect(res).toMatchObject({ kind: "timed", source: "YouTube Music" });
    const lines = (res as { lines: { start: number; text: string }[] }).lines;
    // The attribution row has no cueRange and must not become a line at t=0.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({
      start: 13.57,
      end: 16.11,
      text: "I've been tryna call",
    });
  });

  it("blanks the bare-note interlude rather than printing it twice", async () => {
    // The view already draws its own marker for an empty line.
    const { fetchYtMusicLyrics } = await setup(
      bothHops(nextResponse([tab({})]), timedBrowse),
    );
    const res = await fetchYtMusicLyrics("J7p4bzqLvCw");
    const lines = (res as { lines: { text: string }[] }).lines;
    expect(lines[0].text).toBe("");
  });

  it("sends the mobile client, which is what unlocks timed lyrics", async () => {
    // Load-bearing: on WEB_REMIX the very same browseId returns plain text.
    // Anyone "tidying" this back to the app's default client would silently
    // lose the timings, so pin it.
    const { fetchYtMusicLyrics, calls } = await setup(
      bothHops(nextResponse([tab({})]), timedBrowse),
    );
    await fetchYtMusicLyrics("J7p4bzqLvCw");
    for (const c of calls) {
      const client = (c.body.context as { client: { clientName: string } })
        .client;
      expect(client.clientName).toBe("ANDROID_MUSIC");
    }
  });

  it("stops after one request when YTM marks the tab unselectable", async () => {
    // That flag means "no lyrics for this track", so the browse hop is waste.
    const { fetchYtMusicLyrics, calls } = await setup(
      bothHops(nextResponse([tab({ unselectable: true })]), timedBrowse),
    );
    await expect(fetchYtMusicLyrics("4NRXx6U8ABQ")).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/next");
  });

  it("finds the tab by page type, not by position or title", async () => {
    // Tab order and titles are layout- and locale-dependent.
    const { fetchYtMusicLyrics } = await setup(
      bothHops(
        nextResponse([
          tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED", title: "Up next" }),
          tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED", title: "Related" }),
          tab({ title: "歌詞" }),
        ]),
        timedBrowse,
      ),
    );
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toMatchObject({
      kind: "timed",
    });
  });

  it("falls back to plain text when there are no timings", async () => {
    const { fetchYtMusicLyrics } = await setup(
      bothHops(nextResponse([tab({})]), plainBrowse),
    );
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toMatchObject({
      kind: "plain",
      text: "Yeah\n\nI've been tryna call",
      source: "YouTube Music",
    });
  });

  it("treats an explicit 'not available' as an answer", async () => {
    const { fetchYtMusicLyrics } = await setup(
      bothHops(nextResponse([tab({})]), noLyricsBrowse),
    );
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toBeNull();
  });

  it("returns null when the watch page has no lyrics tab at all", async () => {
    const { fetchYtMusicLyrics } = await setup(
      bothHops(
        nextResponse([tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED" })]),
        timedBrowse,
      ),
    );
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toBeNull();
  });

  it("asks nothing when there is no videoId", async () => {
    const { fetchYtMusicLyrics, calls } = await setup(() => ({}));
    await expect(fetchYtMusicLyrics(undefined)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws on a server error rather than reporting no lyrics", async () => {
    // Same contract as the other three providers: a failure to look up is
    // not evidence of absence, and must not be cached as one.
    const { fetchYtMusicLyrics } = await setup(() => ({}), 503);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).rejects.toThrow(
      /YouTube Music next 503/,
    );
  });
});
