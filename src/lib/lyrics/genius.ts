import type { Lyrics } from "@/lib/lyrics/types";
import { selectBest, type ScoreCandidate } from "@/lib/lyrics/score";
import {
  createDeadline,
  lyricsFetch,
  throwForStatus,
  type Deadline,
} from "@/lib/lyrics/http";

/**
 * Genius (https://genius.com) — plain text only. The official API
 * (api.genius.com) does NOT return lyrics in JSON; it only returns
 * metadata + a page URL. Actual lyrics live in the rendered song page
 * HTML inside `<div data-lyrics-container="true">…</div>` blocks, so
 * we scrape them. That's the same approach `syncedlyrics`,
 * `lyricsgenius`, and the various community clients take.
 *
 * The public search at `genius.com/api/search` doesn't require auth, so
 * we use it instead of the bearer-token API.
 *
 * Tauri's HTTP plugin is required because:
 *   - Genius HTML pages don't set permissive CORS, so a webview
 *     `fetch()` would be blocked.
 *   - We need a real `User-Agent` (Genius 403s on the default webview
 *     UA), and the webview prohibits setting it from JS.
 *   - `genius.com` must also be in `src-tauri/capabilities/default.json`.
 */

const SEARCH_URL = "https://genius.com/api/search";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type GeniusParams = {
  title: string;
  artist?: string;
};

type GeniusSearchResponse = {
  response?: {
    hits?: Array<{
      type?: string;
      result?: {
        url?: string;
        title?: string;
        primary_artist?: { name?: string };
        lyrics_state?: string;
      };
    }>;
  };
};

export async function fetchGeniusLyrics(
  p: GeniusParams,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const deadline = createDeadline(signal);
  try {
    const url = await findSongUrl(p, deadline);
    if (!url) return null;

    const text = await scrapeLyrics(url, deadline);
    if (!text) return null;

    return { kind: "plain", text, source: "Genius" };
  } finally {
    deadline.done();
  }
}

async function findSongUrl(
  p: GeniusParams,
  deadline: Deadline,
): Promise<string | null> {
  const q = p.artist ? `${p.title} ${p.artist}` : p.title;
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", q);

  // Transport failures and non-2xx responses propagate: Genius being
  // unreachable is not evidence that this track has no lyrics, and letting
  // it resolve to null would cache that lie for 24h. See http.ts.
  const r = await lyricsFetch(url.toString(), deadline, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  });
  if (!r.ok) throwForStatus(r.status, "Genius search");
  const json = (await r.json()) as GeniusSearchResponse;
  const hits = json?.response?.hits ?? [];

  // Hits come back ordered by relevance. Keep only song hits whose
  // lyrics page is actually populated (Genius lists "unreleased"
  // tracks with stub pages that scrape to nothing).
  // Hits come back ordered by relevance. Keep only song hits whose
  // lyrics page is actually populated (Genius lists "unreleased"
  // tracks with stub pages that scrape to nothing).
  const usable = hits.filter(
    (h) =>
      h.type === "song" &&
      h.result?.url &&
      h.result?.lyrics_state !== "unreleased",
  );

  // Score every hit and take the best, rather than the first that clears a
  // boolean. Relevance order is not trustworthy: across the probed cases
  // the wrong record sat at rank 0 for "Hurt", "Numb", "Lean On", "Prada",
  // "One Kiss", "Hotel California" and "Die For You".
  //
  // Genius has neither duration nor synced lyrics, so the artist carries
  // the whole decision and the floor is raised to compensate.
  type Hit = (typeof usable)[number];
  const candidates: (ScoreCandidate & { hit: Hit })[] = usable.map((h) => ({
    hit: h,
    trackName: h.result?.title ?? "",
    artistName: h.result?.primary_artist?.name ?? "",
  }));

  const best = selectBest(
    { title: p.title, artist: p.artist },
    candidates,
    { durationBlind: true, bodyUnknown: true },
  );
  // Better no lyrics than a confidently-wrong different song.
  return best?.record.hit.result?.url ?? null;
}

async function scrapeLyrics(
  songUrl: string,
  deadline: Deadline,
): Promise<string | null> {
  const r = await lyricsFetch(songUrl, deadline, {
    "User-Agent": USER_AGENT,
    Accept: "text/html",
  });
  if (!r.ok) throwForStatus(r.status, "Genius page");
  const html = await r.text();
  // A page that scrapes to nothing is a real (if disappointing) answer.
  return extractLyricsFromHtml(html);
}

/**
 * Genius lyrics live in one or more `<div data-lyrics-container="true">`
 * blocks that contain nested `<div>`s (annotation wrappers). A naive
 * non-greedy regex would stop at the first inner `</div>`, so we find
 * each container's opening tag and then walk forward tracking
 * open/close balance to find its matching end.
 */
function extractLyricsContainers(html: string): string[] {
  const openRe = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
  const out: string[] = [];
  for (let m; (m = openRe.exec(html)); ) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf("<div", i);
      const nextClose = html.indexOf("</div>", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        i = nextClose + 6;
      }
    }
    if (depth === 0) out.push(html.substring(start, i - 6));
  }
  return out;
}

function extractLyricsFromHtml(html: string): string | null {
  const blocks = extractLyricsContainers(html);
  if (blocks.length === 0) return null;

  let text = blocks.join("\n");

  // `<br>` → newline. Block-ish tags also break the line so
  // section markers like `[Chorus]` don't collide with the next line.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div)>/gi, "\n");

  // Strip the rest of the tags but keep their inner text (annotations
  // are `<a>` wrappers — their text is part of the lyric line).
  text = text.replace(/<[^>]+>/g, "");

  // Decode the common HTML entities Genius emits. We deliberately don't
  // pull in a full entity table — these cover what shows up in lyrics.
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse runs of blank lines and trim.
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return text.length > 0 ? text : null;
}
