import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chaptersFromPlayer,
  cleanChapterTitle,
  parseClock,
  parseDescriptionChapters,
  parseLinkedDescriptionChapters,
  parseOfficialChapters,
} from "./chapters";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

/**
 * Snippet of the live shortDescription for
 * https://www.youtube.com/watch?v=7E15LSbKm_Q
 * (Divinity: Original Sin OST). Zero-width spaces after each timestamp
 * are how YouTube marks the linked chapter anchors.
 */
const OST_DESCRIPTION = [
  "Composed by Kirill Pokrovsky. RIP (1962 – 2015)",
  "If you know the name of a missing track, please write in the comments.",
  "Album links added.",
  "",
  "0:00\u200b       -   Track 1 - Dance Of Death - http://bit.ly/1AvOjmP\u200b",
  "2:04\u200b       -   Track 2 - Drunk with Dwarven Mirth - http://bit.ly/1r0bcb7\u200b",
  "3:49\u200b       -   Track 3 - Anirban Encounter 3",
  "11:19\u200b      -   Track 7",
  "41:35\u200b      -   Track 16 -",
  "01:01:30\u200b   -   Track 23 -",
  "01:43:47\u200b   -   Track 38    Combat",
].join("\n");

describe("parseClock", () => {
  it("reads m:ss and h:mm:ss", () => {
    expect(parseClock("0:00")).toBe(0);
    expect(parseClock("2:04")).toBe(124);
    expect(parseClock("01:01:30")).toBe(3690);
  });

  it("rejects impossible minutes", () => {
    expect(parseClock("1:80")).toBeUndefined();
  });
});

describe("cleanChapterTitle", () => {
  it("strips the gutter dash, trailing URL, and empty dash", () => {
    expect(
      cleanChapterTitle("       -   Track 1 - Dance Of Death - http://bit.ly/1AvOjmP"),
    ).toBe("Track 1 - Dance Of Death");
    expect(cleanChapterTitle("   -   Track 16 -")).toBe("Track 16");
    expect(cleanChapterTitle("   -   Track 38    Combat")).toBe("Track 38 Combat");
  });
});

describe("parseDescriptionChapters", () => {
  it("parses a real OST description into titled chapters", () => {
    const chapters = parseDescriptionChapters(OST_DESCRIPTION);
    expect(chapters[0]).toEqual({
      start: 0,
      title: "Track 1 - Dance Of Death",
    });
    expect(chapters[1]).toEqual({
      start: 124,
      title: "Track 2 - Drunk with Dwarven Mirth",
    });
    expect(chapters.find((c) => c.start === 3690)?.title).toBe("Track 23");
    expect(chapters.find((c) => c.start === 6227)?.title).toBe("Track 38 Combat");
    expect(chapters).toHaveLength(7);
  });

  it("ignores a description with no timestamp list", () => {
    expect(parseDescriptionChapters("Just a song. No chapters here.")).toEqual(
      [],
    );
  });

  it("ignores stray times that do not open at 0:00", () => {
    expect(
      parseDescriptionChapters("Call us at 3:00 PM\nShow ends 4:15"),
    ).toEqual([]);
  });

  it("accepts bracketed timestamps", () => {
    const chapters = parseDescriptionChapters(
      "[0:00] Intro\n[1:30] Verse",
    );
    expect(chapters).toEqual([
      { start: 0, title: "Intro" },
      { start: 90, title: "Verse" },
    ]);
  });
});

describe("parseOfficialChapters", () => {
  it("reads chapterRenderer markers", () => {
    const root = {
      playerOverlays: {
        markersMap: [
          {
            key: "DESCRIPTION_CHAPTERS",
            value: {
              chapters: [
                {
                  chapterRenderer: {
                    title: { simpleText: "Intro" },
                    timeRangeStartMillis: 0,
                  },
                },
                {
                  chapterRenderer: {
                    title: { simpleText: "Drop" },
                    timeRangeStartMillis: "45000",
                  },
                },
              ],
            },
          },
        ],
      },
    };
    expect(parseOfficialChapters(root)).toEqual([
      { start: 0, title: "Intro" },
      { start: 45, title: "Drop" },
    ]);
  });

  it("reads macroMarkersListItemRenderer rows", () => {
    const root = {
      engagementPanels: [
        {
          macroMarkersListItemRenderer: {
            title: { simpleText: "Cold open" },
            onTap: { watchEndpoint: { startTimeSeconds: 0 } },
          },
        },
        {
          macroMarkersListItemRenderer: {
            title: { runs: [{ text: "Theme" }] },
            onTap: { watchEndpoint: { startTimeSeconds: 12 } },
          },
        },
      ],
    };
    expect(parseOfficialChapters(root)).toEqual([
      { start: 0, title: "Cold open" },
      { start: 12, title: "Theme" },
    ]);
  });
});

describe("parseLinkedDescriptionChapters", () => {
  it("uses commandRuns startTimeSeconds and the rest of the line as the title", () => {
    const content = [
      "Notes",
      "",
      "0:00       -   Track 1 - Dance Of Death - http://bit.ly/1AvOjmP",
      "2:04       -   Track 2 - Drunk with Dwarven Mirth",
    ].join("\n");
    const t1 = content.indexOf("0:00");
    const t2 = content.indexOf("2:04");
    const root = {
      attributedDescriptionBodyText: {
        content,
        commandRuns: [
          {
            startIndex: t1,
            length: 4,
            onTap: {
              innertubeCommand: {
                watchEndpoint: { videoId: "abc", startTimeSeconds: 0 },
              },
            },
          },
          {
            startIndex: t2,
            length: 4,
            onTap: {
              innertubeCommand: {
                watchEndpoint: { videoId: "abc", startTimeSeconds: 124 },
              },
            },
          },
        ],
      },
    };
    expect(parseLinkedDescriptionChapters(root)).toEqual([
      { start: 0, title: "Track 1 - Dance Of Death" },
      { start: 124, title: "Track 2 - Drunk with Dwarven Mirth" },
    ]);
  });
});

describe("chaptersFromPlayer", () => {
  it("prefers official markers over the description", () => {
    const root = {
      videoDetails: { shortDescription: OST_DESCRIPTION },
      chapterRenderer: {
        title: { simpleText: "Official A" },
        timeRangeStartMillis: 0,
      },
      extra: {
        chapterRenderer: {
          title: { simpleText: "Official B" },
          timeRangeStartMillis: 10_000,
        },
      },
    };
    expect(chaptersFromPlayer(root)).toEqual([
      { start: 0, title: "Official A" },
      { start: 10, title: "Official B" },
    ]);
  });

  it("falls back to the description when no markers ship", () => {
    const chapters = chaptersFromPlayer({
      videoDetails: { shortDescription: OST_DESCRIPTION },
    });
    expect(chapters?.[0].title).toBe("Track 1 - Dance Of Death");
    expect(chapters?.length).toBe(7);
  });

  it("returns null when the video has no chapter list", () => {
    expect(
      chaptersFromPlayer({
        videoDetails: { shortDescription: "A regular song." },
      }),
    ).toBeNull();
  });
});

describe("fetchVideoChapters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts WEB /player and returns parsed chapters", async () => {
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          videoDetails: { shortDescription: OST_DESCRIPTION },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { fetchVideoChapters } = await import("./chapters");
    const chapters = await fetchVideoChapters("7E15LSbKm_Q");
    expect(chapters?.[0]).toMatchObject({
      start: 0,
      title: "Track 1 - Dance Of Death",
    });
    const [url, init] = vi.mocked(http.fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain("www.youtube.com/youtubei/v1/player");
    expect(JSON.parse(String((init as { body?: string }).body)).videoId).toBe(
      "7E15LSbKm_Q",
    );
  });

  it("throws on a non-OK player response so the query can retry", async () => {
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    const { fetchVideoChapters } = await import("./chapters");
    await expect(fetchVideoChapters("7E15LSbKm_Q")).rejects.toThrow(
      /player 500/,
    );
  });
});
