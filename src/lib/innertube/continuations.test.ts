import { beforeEach, describe, expect, it, vi } from "vitest";

// `collectContinuationItems` goes through innertubePost, so the two Tauri
// modules it reaches for are stubbed: the HTTP plugin per test, and
// `invoke` as a rejection so `authHeaders` falls back to anonymous.
const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("no tauri in tests")),
}));

const {
  collectContinuationItems,
  collectShelfNodes,
  parseContinuationPage,
  readPagingToken,
} = await import("./shared");

type Json = Record<string, unknown>;

/** Minimal stand-in for the Response `innertubePost` expects back. */
function jsonResponse(body: Json) {
  return {
    ok: true,
    status: 200,
    url: "https://music.youtube.com/youtubei/v1/browse",
    headers: { get: () => null, getSetCookie: () => [] },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  };
}

/** A grid page carrying `count` playlist rows and, optionally, a next token. */
function gridPage(count: number, nextToken?: string): Json {
  const items: Json[] = Array.from({ length: count }, (_, i) => ({
    musicTwoRowItemRenderer: { title: { runs: [{ text: `p${i}` }] } },
  }));
  return {
    continuationContents: {
      gridContinuation: {
        items,
        continuations: nextToken
          ? [{ nextContinuationData: { continuation: nextToken } }]
          : undefined,
      },
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

// The library grid hands back ~25 rows plus a token for the rest. Reading
// that token off the grid itself (rather than the first one anywhere in the
// response) is what keeps a 30+ playlist library from rendering as 25.
describe("readPagingToken", () => {
  it("reads the legacy continuations[].nextContinuationData token", () => {
    const grid = {
      items: [],
      continuations: [{ nextContinuationData: { continuation: "tok-legacy" } }],
    };
    expect(readPagingToken(grid)).toBe("tok-legacy");
  });

  it("reads a continuationCommand token off continuations[]", () => {
    const shelf = {
      contents: [],
      continuations: [
        { continuationEndpoint: { continuationCommand: { token: "tok-cmd" } } },
      ],
    };
    expect(readPagingToken(shelf)).toBe("tok-cmd");
  });

  it("reads the trailing continuationItemRenderer of an item list", () => {
    const grid = {
      items: [
        { musicTwoRowItemRenderer: {} },
        {
          continuationItemRenderer: {
            continuationEndpoint: { continuationCommand: { token: "tok-tail" } },
          },
        },
      ],
    };
    expect(readPagingToken(grid)).toBe("tok-tail");
  });

  it("returns undefined for a shelf that fits on one page", () => {
    expect(readPagingToken({ items: [{ musicTwoRowItemRenderer: {} }] })).toBe(
      undefined,
    );
    expect(readPagingToken(undefined)).toBe(undefined);
  });
});

describe("parseContinuationPage", () => {
  it("unwraps a gridContinuation with its next token", () => {
    const { items, token } = parseContinuationPage(gridPage(2, "tok-2"));
    expect(items).toHaveLength(2);
    expect(token).toBe("tok-2");
  });

  it("unwraps a musicShelfContinuation", () => {
    const { items, token } = parseContinuationPage({
      continuationContents: {
        musicShelfContinuation: {
          contents: [{ musicResponsiveListItemRenderer: {} }],
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(token).toBe(undefined);
  });

  it("unwraps an appendContinuationItemsAction response", () => {
    const { items, token } = parseContinuationPage({
      onResponseReceivedActions: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              { musicTwoRowItemRenderer: {} },
              {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    continuationCommand: { token: "tok-next" },
                  },
                },
              },
            ],
          },
        },
      ],
    });
    expect(items).toHaveLength(2);
    expect(token).toBe("tok-next");
  });

  it("yields nothing for a shape it doesn't know, ending the walk", () => {
    expect(parseContinuationPage({ somethingElse: {} })).toEqual({ items: [] });
    expect(parseContinuationPage(undefined)).toEqual({ items: [] });
  });
});

// The grid is what owns the paging token, so the shelf-like node synthesized
// for it has to carry `continuations` through.
describe("collectShelfNodes", () => {
  it("keeps a gridRenderer's continuations on the synthesized shelf", () => {
    const [wrapper] = collectShelfNodes([
      {
        gridRenderer: {
          items: [{ musicTwoRowItemRenderer: {} }],
          continuations: [{ nextContinuationData: { continuation: "tok" } }],
        },
      },
    ]);
    expect(readPagingToken(wrapper.musicShelfRenderer)).toBe("tok");
  });
});

describe("collectContinuationItems", () => {
  it("returns nothing when there is no token to follow", async () => {
    expect(await collectContinuationItems(undefined)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("walks every page and concatenates the rows in order", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(gridPage(25, "tok-2")))
      .mockResolvedValueOnce(jsonResponse(gridPage(25, "tok-3")))
      .mockResolvedValueOnce(jsonResponse(gridPage(7)));
    const items = await collectContinuationItems("tok-1");
    expect(items).toHaveLength(57);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the pages it already has when one request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(gridPage(25, "tok-2")))
      .mockRejectedValueOnce(new Error("network down"));
    expect(await collectContinuationItems("tok-1")).toHaveLength(25);
  });

  it("stops when a page hands back a token it was already given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(gridPage(25, "tok-loop")));
    const items = await collectContinuationItems("tok-loop");
    expect(items).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps a server that keeps issuing fresh tokens forever", async () => {
    let page = 0;
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(gridPage(1, `tok-${++page}`))),
    );
    const items = await collectContinuationItems("tok-0");
    expect(items).toHaveLength(40);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });
});
