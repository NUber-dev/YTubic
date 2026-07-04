import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Lyrics } from "@/lib/lyrics/types";

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
): Promise<Lyrics | null> {
  if (!p.title) return null;

  const url = await findSongUrl(p);
  if (!url) return null;

  const text = await scrapeLyrics(url);
  if (!text) return null;

  return { kind: "plain", text, source: "Genius" };
}

/** Normalize a title/artist for fuzzy comparison: drop parentheticals,
 *  featurings, and punctuation; lowercase; collapse whitespace. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\bfeat\.?\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Ratio of shared tokens over the smaller token set (0..1). */
function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Does a Genius hit plausibly match the requested track? Genius search is
 *  fuzzy and almost always returns *something*, so without this check the
 *  first hit for a track Genius lacks is a confidently-wrong different song. */
function hitMatches(
  reqTitle: string,
  reqArtist: string,
  hitTitle: string,
  hitArtist: string,
): boolean {
  if (!hitTitle) return false;
  const titleOk =
    hitTitle.includes(reqTitle) ||
    reqTitle.includes(hitTitle) ||
    tokenOverlap(reqTitle, hitTitle) >= 0.6;
  if (!titleOk) return false;
  // Only enforce artist agreement when both sides are known.
  if (!reqArtist || !hitArtist) return true;
  return (
    hitArtist.includes(reqArtist) ||
    reqArtist.includes(hitArtist) ||
    tokenOverlap(reqArtist, hitArtist) >= 0.5
  );
}

async function findSongUrl(p: GeniusParams): Promise<string | null> {
  const q = p.artist ? `${p.title} ${p.artist}` : p.title;
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", q);

  try {
    const r = await tauriFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const json = (await r.json()) as GeniusSearchResponse;
    const hits = json?.response?.hits ?? [];

    // Hits come back ordered by relevance. Keep only song hits whose
    // lyrics page is actually populated (Genius lists "unreleased"
    // tracks with stub pages that scrape to nothing).
    const usable = hits.filter(
      (h) =>
        h.type === "song" &&
        h.result?.url &&
        h.result?.lyrics_state !== "unreleased",
    );
    const reqTitle = normalizeForMatch(p.title);
    const reqArtist = p.artist ? normalizeForMatch(p.artist) : "";
    for (const h of usable) {
      const hitTitle = normalizeForMatch(h.result?.title ?? "");
      const hitArtist = normalizeForMatch(h.result?.primary_artist?.name ?? "");
      if (hitMatches(reqTitle, reqArtist, hitTitle, hitArtist)) {
        return h.result?.url ?? null;
      }
    }
    // No hit passed the title/artist check — better no lyrics than a
    // confidently-wrong different song.
    return null;
  } catch {
    return null;
  }
}

async function scrapeLyrics(songUrl: string): Promise<string | null> {
  try {
    const r = await tauriFetch(songUrl, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!r.ok) return null;
    const html = await r.text();
    return extractLyricsFromHtml(html);
  } catch {
    return null;
  }
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
