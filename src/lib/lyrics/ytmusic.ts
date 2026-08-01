import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import {
  createDeadline,
  lyricsFetch,
  throwForStatus,
  type Deadline,
} from "@/lib/lyrics/http";

/**
 * YouTube Music's own lyrics, over InnerTube.
 *
 * Structurally different from the other three providers, and that is the
 * entire point: this one is keyed on the track's videoId, not on a fuzzy
 * title/artist string. It cannot return another song's words. Every
 * "wrong lyrics" report is a string-matching failure, and there is no
 * string matching here.
 *
 * Two hops:
 *   1. `/next` with the videoId returns the watch page's tabs. One of them
 *      is Lyrics, carrying an `MPLYt...` browseId. A tab marked
 *      `unselectable` means YTM has no lyrics for this track; that is an
 *      answer, and it costs no second request to learn it.
 *   2. `/browse` with that browseId returns the lyrics themselves.
 *
 * The response *shape* is decided by the client context, which is the
 * non-obvious part. Measured against the live API:
 *   - WEB_REMIX (what the rest of the app sends) returns plain text only.
 *   - ANDROID_MUSIC and IOS_MUSIC return line-synced lyrics.
 * Blinding Lights came back as 40 timed lines and YOASOBI's アイドル as 77,
 * against plain text for the same tracks on WEB_REMIX.
 *
 * Deliberately anonymous: no cookies, no SAPISIDHASH, and none of
 * `innertube/shared.ts`'s authenticated machinery. Two reasons. It was
 * verified to work signed out, so auth buys nothing measurable. And
 * pairing the user's real Google cookies with a mobile client context is
 * exactly the sort of mismatch that anti-abuse systems notice, which is a
 * poor trade for a lyrics panel in an app that already has a history of
 * session trouble. If coverage gaps turn up later that auth would close,
 * that is the moment to reconsider, with evidence.
 *
 * Known limit, also measured: music videos (OMV) have no lyrics tab, and
 * their `/next` response does NOT name the audio counterpart, so there is
 * no free way to hop to the ATV track. Those fall through to the other
 * providers rather than costing an extra search round-trip.
 */

const YTM_API_BASE = "https://music.youtube.com/youtubei/v1";

/**
 * The client that unlocks timed lyrics. Version pinned rather than
 * floated: this is a reverse-engineered surface, and a version YTM stops
 * recognising fails loudly here rather than silently degrading to plain
 * text somewhere else.
 */
const ANDROID_MUSIC = {
  clientName: "ANDROID_MUSIC",
  clientVersion: "7.21.50",
  androidSdkVersion: 34,
  hl: "en",
  gl: "US",
};

const CLIENT_NAME_ID = "21";

/**
 * The exact header set the probe ran with. A desktop User-Agent alongside
 * a mobile client context reads oddly, but it is what was verified to
 * return timed lyrics, and verified beats plausible on an undocumented
 * API.
 */
const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-YouTube-Client-Name": CLIENT_NAME_ID,
  "X-YouTube-Client-Version": ANDROID_MUSIC.clientVersion,
  Origin: "https://music.youtube.com",
  Referer: "https://music.youtube.com/",
  Accept: "*/*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

type YtNode = Record<string, unknown>;

export async function fetchYtMusicLyrics(
  videoId: string | undefined,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!videoId) return null;

  const deadline = createDeadline(signal);
  try {
    const browseId = await findLyricsBrowseId(videoId, deadline);
    // No tab, or a tab YTM marked unselectable: it has nothing for this
    // track. A real answer, worth caching.
    if (!browseId) return null;
    return await fetchLyricsPage(browseId, deadline);
  } finally {
    deadline.done();
  }
}

async function innertube(
  endpoint: string,
  body: Record<string, unknown>,
  deadline: Deadline,
): Promise<YtNode> {
  const url = `${YTM_API_BASE}/${endpoint}?prettyPrint=false`;
  const r = await lyricsFetch(url, deadline, HEADERS, {
    ...body,
    context: { client: ANDROID_MUSIC },
  });
  if (!r.ok) throwForStatus(r.status, `YouTube Music ${endpoint}`);
  return (await r.json()) as YtNode;
}

/**
 * Walk the response for every value stored under `key`, at any depth.
 *
 * The literal paths into these payloads are eight or nine segments long
 * and YTM reshapes them without notice. A search costs microseconds on a
 * response this size and survives a renamed wrapper, which a hardcoded
 * path does not.
 */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

function findLyricsBrowseId(
  videoId: string,
  deadline: Deadline,
): Promise<string | null> {
  return innertube("next", { videoId }, deadline).then((res) => {
    for (const tab of collect(res, "tabRenderer") as YtNode[]) {
      const endpoint = (tab?.endpoint as YtNode)?.browseEndpoint as YtNode;
      if (!endpoint) continue;
      const pageType = (
        (
          (endpoint.browseEndpointContextSupportedConfigs as YtNode)
            ?.browseEndpointContextMusicConfig as YtNode
        )?.pageType as string
      );
      // Select on the page type, not on the tab's index or its title:
      // both are localisation- and layout-dependent.
      if (pageType !== "MUSIC_PAGE_TYPE_TRACK_LYRICS") continue;
      // Set when the track has no lyrics. Bail without a second request.
      if (tab.unselectable === true) return null;
      const browseId = endpoint.browseId;
      return typeof browseId === "string" && browseId ? browseId : null;
    }
    return null;
  });
}

async function fetchLyricsPage(
  browseId: string,
  deadline: Deadline,
): Promise<Lyrics | null> {
  const res = await innertube("browse", { browseId }, deadline);

  const timed = parseTimed(res);
  if (timed) return timed;

  const plain = parsePlain(res);
  if (plain) return plain;

  // "Lyrics not available" and friends: an answer, not a failure.
  return null;
}

type TimedRow = {
  lyricLine?: string;
  cueRange?: {
    startTimeMilliseconds?: string | number;
    endTimeMilliseconds?: string | number;
  };
};

/** Milliseconds arrive as JSON strings, not numbers. */
function ms(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n / 1000 : undefined;
}

function parseTimed(res: YtNode): Lyrics | null {
  const blocks = collect(res, "timedLyricsData") as TimedRow[][];
  const rows = blocks.find((b) => Array.isArray(b) && b.length > 0);
  if (!rows) return null;

  const lines: TimedLine[] = [];
  for (const row of rows) {
    // A trailing attribution row ("Source: Musixmatch") rides along with
    // no cueRange; without this it would land at t=0 and shadow the first
    // real line.
    const start = ms(row?.cueRange?.startTimeMilliseconds);
    if (start === undefined) continue;
    const text = (row?.lyricLine ?? "").trim();
    lines.push({
      start,
      end: ms(row?.cueRange?.endTimeMilliseconds),
      // YTM writes an interlude as a bare note; the view already draws its
      // own marker for an empty line, so don't double up.
      text: text === "♪" ? "" : text,
    });
  }
  if (lines.length === 0) return null;
  lines.sort((a, b) => a.start - b.start);
  return { kind: "timed", lines, source: "YouTube Music" };
}

function parsePlain(res: YtNode): Lyrics | null {
  for (const shelf of collect(
    res,
    "musicDescriptionShelfRenderer",
  ) as YtNode[]) {
    const runs = collect(shelf?.description, "runs")[0] as
      | { text?: string }[]
      | undefined;
    const text = (runs ?? [])
      .map((r) => r?.text ?? "")
      .join("")
      .trim();
    if (text) return { kind: "plain", text, source: "YouTube Music" };
  }
  return null;
}
