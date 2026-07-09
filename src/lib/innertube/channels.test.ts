import { describe, expect, it } from "vitest";
import { parseAccountSwitcher, stripXssiPrefix } from "./channels";

/**
 * Trimmed-down shape of a real getAccountSwitcherEndpoint response:
 * one personal channel (no pageIdToken), one brand channel (with
 * pageIdToken), and one non-identity row that must be skipped.
 */
const SWITCHER_FIXTURE = {
  data: {
    actions: [
      {
        getMultiPageMenuAction: {
          menu: {
            multiPageMenuRenderer: {
              sections: [
                {
                  accountSectionListRenderer: {
                    contents: [
                      {
                        accountItemSectionRenderer: {
                          contents: [
                            {
                              accountItem: {
                                accountName: { simpleText: "George" },
                                accountPhoto: {
                                  thumbnails: [
                                    { url: "https://p/a=s48", width: 48 },
                                    { url: "https://p/a=s88", width: 88 },
                                  ],
                                },
                                isSelected: true,
                                accountByline: {
                                  simpleText: "george@gmail.com",
                                },
                                serviceEndpoint: {
                                  selectActiveIdentityEndpoint: {
                                    supportedTokens: [
                                      { accountStateToken: { hasChannel: true } },
                                      {
                                        offlineCacheKeyToken: {
                                          clientCacheKey: "k1",
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                            {
                              accountItem: {
                                accountName: {
                                  runs: [{ text: "Band Channel" }],
                                },
                                accountPhoto: {
                                  thumbnails: [{ url: "https://p/b=s88" }],
                                },
                                isSelected: false,
                                accountByline: { simpleText: "Brand Account" },
                                serviceEndpoint: {
                                  selectActiveIdentityEndpoint: {
                                    supportedTokens: [
                                      {
                                        pageIdToken: {
                                          pageId: "108031863270526872265",
                                        },
                                      },
                                      {
                                        offlineCacheKeyToken: {
                                          clientCacheKey: "k2",
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                            {
                              // "Add account" style row: no select endpoint.
                              accountItem: {
                                accountName: { simpleText: "Add account" },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    ],
  },
};

describe("stripXssiPrefix", () => {
  it("removes the )]}' guard", () => {
    expect(stripXssiPrefix(")]}'\n{\"a\":1}")).toBe('{"a":1}');
  });

  it("leaves plain JSON untouched", () => {
    expect(stripXssiPrefix('{"a":1}')).toBe('{"a":1}');
    expect(stripXssiPrefix("[1,2]")).toBe("[1,2]");
  });
});

describe("parseAccountSwitcher", () => {
  const channels = parseAccountSwitcher(SWITCHER_FIXTURE);

  it("finds both identities and skips non-identity rows", () => {
    expect(channels).toHaveLength(2);
  });

  it("maps the personal channel with a null pageId", () => {
    expect(channels[0]).toEqual({
      pageId: null,
      name: "George",
      photoUrl: "https://p/a=s88",
      byline: "george@gmail.com",
      selected: true,
    });
  });

  it("maps the brand channel with its pageId", () => {
    expect(channels[1]).toEqual({
      pageId: "108031863270526872265",
      name: "Band Channel",
      photoUrl: "https://p/b=s88",
      byline: "Brand Account",
      selected: false,
    });
  });

  it("returns [] for garbage input", () => {
    expect(parseAccountSwitcher(null)).toEqual([]);
    expect(parseAccountSwitcher({ data: {} })).toEqual([]);
    expect(parseAccountSwitcher("nope")).toEqual([]);
  });
});
