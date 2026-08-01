import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invariant every lyrics provider now upholds: return a value only for
 * a real answer, throw for anything a retry might fix.
 *
 * Before this, all three collapsed failures into `null` with a bare
 * `catch { return null }`. React Query stores `null` as a success,
 * `App.tsx:49` dehydrates successes to IndexedDB and `query-client.ts:9`
 * keeps them a day, so one dropped packet became a persistent, unretryable
 * "No lyrics found." Each `throws` case below is a line that used to
 * resolve to `null`.
 *
 * These tests reach further than the rest of the suite, which the vitest
 * config describes as covering pure logic only: the Tauri HTTP plugin is
 * mocked so the providers' branching can be exercised without a runtime.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.0.0-test"),
}));

type Route = (url: string) => Response | Promise<Response> | never;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

/**
 * Fresh module graph per test. Musixmatch caches its user token in a
 * module-level variable for nine minutes, so without this a token saved by
 * one test silently satisfies the next one and the assertions drift.
 */
async function setup(route: Route) {
  vi.resetModules();
  const http = await import("@tauri-apps/plugin-http");
  const fetchMock = vi.mocked(http.fetch);
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: unknown) =>
    Promise.resolve(route(String(input))),
  );
  return {
    fetchMock,
    lrclib: (await import("./lrclib")).fetchLrclibLyrics,
    genius: (await import("./genius")).fetchGeniusLyrics,
    musixmatch: (await import("./musixmatch")).fetchMusixmatchLyrics,
  };
}

const TRACK = { title: "Blinding Lights", artist: "The Weeknd" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LRCLIB failure semantics", () => {
  it("returns null when the track is genuinely absent", async () => {
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json({}, 404) : json([]),
    );
    await expect(lrclib(TRACK)).resolves.toBeNull();
  });

  it("throws when the search endpoint is broken", async () => {
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json({}, 404) : json({}, 500),
    );
    await expect(lrclib(TRACK)).rejects.toThrow(/LRCLIB \/search 500/);
  });

  it("throws when the transport fails outright", async () => {
    vi.resetModules();
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockReset();
    vi.mocked(http.fetch).mockRejectedValue(new Error("ECONNRESET"));
    const { fetchLrclibLyrics } = await import("./lrclib");
    const { LyricsTransportError } = await import("./http");
    await expect(fetchLrclibLyrics(TRACK)).rejects.toBeInstanceOf(
      LyricsTransportError,
    );
  });
});

describe("Genius failure semantics", () => {
  const noHits = { response: { hits: [] } };

  it("returns null when no hit passes the title/artist check", async () => {
    const { genius } = await setup(() => json(noHits));
    await expect(genius(TRACK)).resolves.toBeNull();
  });

  it("throws on a broken search instead of reporting no lyrics", async () => {
    const { genius } = await setup(() => json({}, 500));
    await expect(genius(TRACK)).rejects.toThrow(/Genius search 500/);
  });

  it("throws when the song page itself fails", async () => {
    const hit = {
      response: {
        hits: [
          {
            type: "song",
            result: {
              url: "https://genius.com/the-weeknd-blinding-lights-lyrics",
              title: "Blinding Lights",
              primary_artist: { name: "The Weeknd" },
              lyrics_state: "complete",
            },
          },
        ],
      },
    };
    const { genius } = await setup((url) =>
      url.includes("/api/search") ? json(hit) : html("nope", 403),
    );
    await expect(genius(TRACK)).rejects.toThrow(/Genius page 403/);
  });
});

describe("Musixmatch failure semantics", () => {
  // A factory, not a value: a Response body can only be read once, and
  // these routes are hit repeatedly within a single test.
  const goodToken = () =>
    json({ message: { body: { user_token: "tok123" } } });

  it("throws when the token endpoint hands back the rate-limit sentinel", async () => {
    const { musixmatch } = await setup(() =>
      json({ message: { body: { user_token: "UpgradeOnlyUpgradeOnly" } } }),
    );
    const { LyricsRateLimitError } = await import("./http");
    await expect(musixmatch(TRACK)).rejects.toBeInstanceOf(
      LyricsRateLimitError,
    );
  });

  it("returns null when the search genuinely finds nothing", async () => {
    const { musixmatch } = await setup((url) =>
      url.includes("token.get")
        ? goodToken()
        : json({ message: { header: { status_code: 404 }, body: {} } }),
    );
    await expect(musixmatch(TRACK)).resolves.toBeNull();
  });

  it("throws when the search endpoint is failing", async () => {
    const { musixmatch } = await setup((url) =>
      url.includes("token.get") ? goodToken() : json({}, 503),
    );
    await expect(musixmatch(TRACK)).rejects.toThrow(/track\.search 503/);
  });

  it("throws when the token is rejected even after being reissued", async () => {
    const { musixmatch, fetchMock } = await setup((url) =>
      url.includes("token.get") ? goodToken() : json({}, 401),
    );
    const { LyricsRateLimitError } = await import("./http");
    await expect(musixmatch(TRACK)).rejects.toBeInstanceOf(
      LyricsRateLimitError,
    );
    // Proves the invalidate-and-retry path ran rather than giving up: two
    // token fetches, two searches.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("token.get"))).toHaveLength(2);
  });

  it("surfaces an envelope-level 500 rather than treating it as no lyrics", async () => {
    const { musixmatch } = await setup((url) =>
      url.includes("token.get")
        ? goodToken()
        : json({ message: { header: { status_code: 500 } } }),
    );
    await expect(musixmatch(TRACK)).rejects.toThrow(/envelope 500/);
  });
});

describe("deadlines", () => {
  /** A fetch that never settles on its own, only when aborted, which is what
   *  a stalled socket looks like from JS. */
  function hangUntilAborted() {
    return (_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
  }

  it("gives up on a stalled request instead of hanging forever", async () => {
    vi.resetModules();
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockReset();
    vi.mocked(http.fetch).mockImplementation(
      hangUntilAborted() as unknown as typeof http.fetch,
    );
    const { createDeadline, lyricsFetch, LyricsTimeoutError } =
      await import("./http");

    const deadline = createDeadline(undefined, 20);
    await expect(
      lyricsFetch("https://lrclib.net/api/search", deadline, {}),
    ).rejects.toBeInstanceOf(LyricsTimeoutError);
    deadline.done();
  });

  it("bounds a whole provider lookup, not just one request", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const http = await import("@tauri-apps/plugin-http");
      vi.mocked(http.fetch).mockReset();
      vi.mocked(http.fetch).mockImplementation(
        hangUntilAborted() as unknown as typeof http.fetch,
      );
      const { fetchLrclibLyrics } = await import("./lrclib");
      const { LyricsTimeoutError, PROVIDER_TIMEOUT_MS } = await import(
        "./http"
      );

      const pending = fetchLrclibLyrics(TRACK);
      const assertion = expect(pending).rejects.toBeInstanceOf(
        LyricsTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an upstream cancellation through untouched", async () => {
    vi.resetModules();
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockReset();
    vi.mocked(http.fetch).mockImplementation(
      hangUntilAborted() as unknown as typeof http.fetch,
    );
    const { createDeadline, lyricsFetch, LyricsTransportError } =
      await import("./http");

    // React Query aborts its signal when the track changes. That is a
    // cancellation, not a provider failure, so it must not be rewrapped
    // into an error that marks the query as failed.
    const upstream = new AbortController();
    const deadline = createDeadline(upstream.signal, 10_000);
    const pending = lyricsFetch("https://lrclib.net/api/get", deadline, {});
    upstream.abort();
    await expect(pending).rejects.not.toBeInstanceOf(LyricsTransportError);
    deadline.done();
  });
});

describe("retry policy", () => {
  it("retries a transport failure once, then stops", async () => {
    const { shouldRetryLyricsQuery, LyricsTransportError } =
      await import("./http");
    const err = new LyricsTransportError("boom");
    expect(shouldRetryLyricsQuery(0, err)).toBe(true);
    expect(shouldRetryLyricsQuery(1, err)).toBe(false);
  });

  it("never retries a rate-limit refusal", async () => {
    const { shouldRetryLyricsQuery, LyricsRateLimitError } =
      await import("./http");
    // Retrying here is what turns a two-minute Musixmatch gate into a
    // self-sustaining one, since the panel already fires on every track.
    expect(
      shouldRetryLyricsQuery(0, new LyricsRateLimitError("gated")),
    ).toBe(false);
  });

  it("retries a timeout, which may just be a slow network", async () => {
    const { shouldRetryLyricsQuery, LyricsTimeoutError } =
      await import("./http");
    expect(shouldRetryLyricsQuery(0, new LyricsTimeoutError(8000))).toBe(true);
  });
});

describe("429 classification", () => {
  // Regression guard: 429 originally sat inside `isTransientStatus`
  // alongside 5xx, so being told "too many requests" earned an immediate
  // retry. Every provider must classify it as a refusal instead.
  it("treats an LRCLIB 429 as a refusal, not a retryable fault", async () => {
    const { lrclib } = await setup(() => json({}, 429));
    const { LyricsRateLimitError, shouldRetryLyricsQuery } =
      await import("./http");
    const err = await lrclib(TRACK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LyricsRateLimitError);
    expect(shouldRetryLyricsQuery(0, err as Error)).toBe(false);
  });

  it("treats a Genius 429 the same way", async () => {
    const { genius } = await setup(() => json({}, 429));
    const { LyricsRateLimitError } = await import("./http");
    await expect(genius(TRACK)).rejects.toBeInstanceOf(LyricsRateLimitError);
  });

  it("still retries a 503, which is the provider breaking rather than refusing", async () => {
    const { genius } = await setup(() => json({}, 503));
    const { LyricsRateLimitError, shouldRetryLyricsQuery } =
      await import("./http");
    const err = await genius(TRACK).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LyricsRateLimitError);
    expect(shouldRetryLyricsQuery(0, err as Error)).toBe(true);
  });
});

describe("LRCLIB record selection", () => {
  // These fixtures name the track the query asks for. They did not before,
  // and passed anyway, because nothing verified that the record returned was
  // the song requested. The scorer rejects a mismatch outright now, which is
  // the whole point of it.
  const LRC = "[00:01.00]I have been tryna call";

  const plainGet = {
    trackName: "Blinding Lights",
    artistName: "The Weeknd",
    duration: 200,
    plainLyrics: "just the words",
  };
  const syncedTwin = [
    {
      trackName: "Blinding Lights",
      artistName: "The Weeknd",
      duration: 201,
      syncedLyrics: LRC,
    },
  ];

  it("uses /search when /get is broken, instead of losing both", async () => {
    // The old Promise.all rejected the pair, discarding a good record.
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json({}, 500) : json(syncedTwin),
    );
    await expect(lrclib({ ...TRACK, duration: 201 })).resolves.toMatchObject({
      kind: "timed",
    });
  });

  it("prefers a synced record over a plain one for the same recording", async () => {
    // LRCLIB stores one song under several rows, and often only one of them
    // carries the timings.
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json(plainGet) : json(syncedTwin),
    );
    await expect(lrclib({ ...TRACK, duration: 200 })).resolves.toMatchObject({
      kind: "timed",
    });
  });

  it("keeps the right song's plain text over another song's synced text", async () => {
    // /get no longer wins by precedence; it wins because the scorer rejects
    // the stranger. Having timings is never a reason to accept a wrong song.
    const { lrclib } = await setup((url) =>
      url.includes("/api/get")
        ? json(plainGet)
        : json([
            {
              trackName: "Something Else Entirely",
              artistName: "A Different Band",
              duration: 200,
              syncedLyrics: LRC,
            },
          ]),
    );
    await expect(lrclib({ ...TRACK, duration: 200 })).resolves.toMatchObject({
      kind: "plain",
      text: "just the words",
    });
  });

  it("throws when /get merely missed and /search is the one that broke", async () => {
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json({}, 404) : json({}, 500),
    );
    await expect(lrclib(TRACK)).rejects.toThrow(/LRCLIB .search 500/);
  });

  it("still reports a genuine absence as an answer", async () => {
    const { lrclib } = await setup((url) =>
      url.includes("/api/get") ? json({}, 404) : json([]),
    );
    await expect(lrclib(TRACK)).resolves.toBeNull();
  });
});

describe("retrieval widening for romanized names", () => {
  const SYNC = "[00:01.00]М, м";

  it("asks by title alone as well when the artist is Cyrillic", async () => {
    // Providers filter by artist server-side, by containment. Asking for
    // "Скриптонит" returns only the Cyrillic-credited rows, which for this
    // track are all unsynced; the synced ones are filed as "Skryptonite"
    // and surface only without an artist filter. No amount of scoring fixes
    // that, because those rows never reach the scorer.
    const calls: string[] = [];
    vi.resetModules();
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockReset();
    vi.mocked(http.fetch).mockImplementation((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/get")) return Promise.resolve(json({}, 404));
      const hasArtist = url.includes("artist_name=");
      return Promise.resolve(
        json(
          hasArtist
            ? [{ trackName: "Жить как я живу", artistName: "Скриптонит", duration: 218, plainLyrics: "М, м" }]
            : [
                { trackName: "Жить как я живу", artistName: "Скриптонит", duration: 218, plainLyrics: "М, м" },
                { trackName: "Жить как я живу", artistName: "Skryptonite", duration: 218, syncedLyrics: SYNC },
              ],
        ),
      );
    });
    const { fetchLrclibLyrics } = await import("./lrclib");

    const res = await fetchLrclibLyrics({
      title: "Жить как я живу",
      artist: "Скриптонит",
      duration: 218,
    });
    // The romanized row wins, so the user gets timings instead of prose.
    expect(res).toMatchObject({ kind: "timed" });
    expect(calls.some((u) => u.includes("/api/search") && !u.includes("artist_name="))).toBe(true);
  });

  it("does not widen for a Latin artist, so most tracks cost nothing extra", async () => {
    const calls: string[] = [];
    vi.resetModules();
    const http = await import("@tauri-apps/plugin-http");
    vi.mocked(http.fetch).mockReset();
    vi.mocked(http.fetch).mockImplementation((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(json([]));
    });
    const { fetchLrclibLyrics } = await import("./lrclib");
    await fetchLrclibLyrics({ title: "Blinding Lights", artist: "The Weeknd", duration: 200 });
    expect(calls.filter((u) => u.includes("/api/search"))).toHaveLength(1);
  });

  it("still refuses the strangers a title-only search drags in", async () => {
    // The reason widening looked forbidden. It is safe because the artist
    // is still verified: only the retrieval broadened, not the check.
    const { selectBest } = await import("./score");
    const best = selectBest(
      { title: "Alone", artist: "Marshmello", durationSec: 264 },
      [
        { trackName: "Alone", artistName: "Parkway Drive", duration: 271, syncedLyrics: SYNC },
        { trackName: "Alone", artistName: "Heart", duration: 263, syncedLyrics: SYNC },
      ],
    );
    expect(best).toBeNull();
  });
});
