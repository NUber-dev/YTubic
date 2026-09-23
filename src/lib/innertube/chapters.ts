import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { readRuns, type YtNode } from "./shared";

/**
 * Timestamped chapters on a YouTube video — the clickable markers the
 * official player draws on the progress bar, and the "0:00 Track name"
 * links in the description that produce them.
 *
 * YT Music's WEB_REMIX `/next` and `/player` do not carry this data
 * (verified against a 152-chapter OST). The regular YouTube WEB `/player`
 * does: `videoDetails.shortDescription` has the timestamp list, and some
 * videos also ship a structured `chapterRenderer` / `markersMap`.
 *
 * Anonymous on purpose, same rationale as YTM lyrics: it works signed
 * out, and pairing the user's Google cookies with a www.youtube.com WEB
 * client is a mismatch we don't need for a read-only metadata panel.
 */

export type VideoChapter = {
  start: number;
  title: string;
};

const YT_API = "https://www.youtube.com/youtubei/v1";

const WEB_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240815.01.00",
  hl: "en",
  gl: "US",
};

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-YouTube-Client-Name": "1",
  "X-YouTube-Client-Version": WEB_CLIENT.clientVersion,
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/** Zero-width space / BOM YouTube inserts around linked timestamps. */
const INVISIBLE = /\u200b|\ufeff/g;

export async function fetchVideoChapters(
  videoId: string | undefined,
  signal?: AbortSignal,
): Promise<VideoChapter[] | null> {
  if (!videoId) return null;

  const res = await tauriFetch(`${YT_API}/player?prettyPrint=false`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      context: { client: WEB_CLIENT },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`YouTube player ${res.status}`);
  }
  const json = (await res.json()) as YtNode;
  return chaptersFromPlayer(json);
}

/**
 * Pull chapters out of a WEB `/player` (or `/next`) payload. Official
 * markers win when present — their titles are already cleaned. Otherwise
 * we parse the description's timestamp list, which is what YouTube itself
 * turns into linked chapters.
 */
export function chaptersFromPlayer(root: YtNode): VideoChapter[] | null {
  const official = parseOfficialChapters(root);
  if (official && official.length >= 2) return official;

  const desc = root?.videoDetails?.shortDescription;
  if (typeof desc === "string") {
    const parsed = parseDescriptionChapters(desc);
    if (parsed.length >= 2) return parsed;
  }

  const linked = parseLinkedDescriptionChapters(root);
  if (linked && linked.length >= 2) return linked;

  return null;
}

/**
 * Structured chapter renderers. Walks the tree rather than a hardcoded
 * path: WEB `/player` puts them under `markersMap`, WEB `/next` under an
 * engagement panel, and either wrapper has been renamed before.
 */
export function parseOfficialChapters(root: unknown): VideoChapter[] | null {
  const fromRenderer: VideoChapter[] = [];
  const fromMarkers: VideoChapter[] = [];
  walk(root, (node) => {
    if (node.chapterRenderer && typeof node.chapterRenderer === "object") {
      const ch = chapterFromRenderer(node.chapterRenderer as YtNode);
      if (ch) fromRenderer.push(ch);
      return;
    }
    if (
      node.macroMarkersListItemRenderer &&
      typeof node.macroMarkersListItemRenderer === "object"
    ) {
      const ch = chapterFromMacro(node.macroMarkersListItemRenderer as YtNode);
      if (ch) fromRenderer.push(ch);
      return;
    }
    if (node.key === "DESCRIPTION_CHAPTERS" && node.value) {
      const chapters = (node.value as YtNode).chapters;
      if (Array.isArray(chapters)) {
        for (const entry of chapters) {
          const raw = (entry as YtNode)?.chapterRenderer as YtNode | undefined;
          const ch = raw ? chapterFromRenderer(raw) : null;
          if (ch) fromMarkers.push(ch);
        }
      }
    }
  });
  const list = fromMarkers.length >= 2 ? fromMarkers : fromRenderer;
  return finalize(list);
}

/**
 * Description timestamps of the form YouTube promotes to chapters:
 *
 *   0:00  Track 1 - Dance Of Death
 *   2:04  Track 2 - Drunk with Dwarven Mirth
 *   01:01:30  Track 23
 *
 * Requires a 0:00 opener and at least two hits, matching YouTube's own
 * rule for turning a timestamp list into linked chapters. Stray times
 * in prose ("call 3:00 PM") therefore don't become a one-item "chapter".
 */
export function parseDescriptionChapters(description: string): VideoChapter[] {
  const lines = description.replace(/\r\n/g, "\n").split("\n");
  const out: VideoChapter[] = [];
  for (const raw of lines) {
    const line = raw.replace(INVISIBLE, "").trim();
    const parsed = parseTimestampLine(line);
    if (parsed) out.push(parsed);
  }
  return finalize(out) ?? [];
}

/**
 * Linked timestamps in a WEB `/next` attributed description. Each
 * `commandRun` with a `watchEndpoint.startTimeSeconds` is one chapter
 * YouTube already decided to make clickable — more precise than a regex
 * when we happen to have the next payload.
 */
export function parseLinkedDescriptionChapters(
  root: unknown,
): VideoChapter[] | null {
  const out: VideoChapter[] = [];
  walk(root, (node) => {
    const content = node.content;
    const runs = node.commandRuns;
    if (typeof content !== "string" || !Array.isArray(runs)) return;
    for (const run of runs) {
      const r = run as YtNode;
      const start = startTimeSeconds(r);
      if (start === undefined) continue;
      const idx = typeof r.startIndex === "number" ? r.startIndex : 0;
      const len = typeof r.length === "number" ? r.length : 0;
      const after = idx + len;
      const nl = content.indexOf("\n", after);
      const rest = content.slice(after, nl === -1 ? undefined : nl);
      out.push({
        start,
        title: cleanChapterTitle(rest.replace(INVISIBLE, "")),
      });
    }
  });
  return finalize(out);
}

function parseTimestampLine(line: string): VideoChapter | null {
  // Optional wrapping brackets: "[0:00] Intro" / "(0:00) Intro".
  const m = line.match(/^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?(?!\d)(.*)$/);
  if (!m) return null;
  const start = parseClock(m[1]);
  if (start === undefined) return null;
  return { start, title: cleanChapterTitle(m[2]) };
}

/** "2:04" / "01:01:30" → seconds. Rejects impossible minutes/seconds. */
export function parseClock(text: string): number | undefined {
  const parts = text.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  let h = 0;
  let m: number;
  let s: number;
  if (parts.length === 2) {
    [m, s] = parts;
  } else if (parts.length === 3) {
    [h, m, s] = parts;
  } else {
    return undefined;
  }
  if (m > 59 || s > 59) return undefined;
  return h * 3600 + m * 60 + s;
}

export function cleanChapterTitle(raw: string): string {
  let t = raw.replace(INVISIBLE, "").trim();
  // Leading separators the timestamp list uses as a gutter.
  t = t.replace(/^[-–—|:·.•]+\s*/, "");
  // Trailing " - https://…" album links that ride along on OST dumps.
  t = t.replace(/\s*[-–—]\s*https?:\/\/\S+\s*$/i, "");
  t = t.replace(/\s*https?:\/\/\S+\s*$/i, "");
  t = t.replace(/\s*[-–—|:]\s*$/, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function chapterFromRenderer(raw: YtNode): VideoChapter | null {
  const title = readRuns(raw.title).trim();
  const ms = asNumber(raw.timeRangeStartMillis);
  const start =
    ms !== undefined
      ? ms / 1000
      : (startTimeSeconds(raw) ?? startTimeSeconds(raw.onActiveCommand));
  if (start === undefined) return null;
  return { start, title };
}

function chapterFromMacro(raw: YtNode): VideoChapter | null {
  const title = readRuns(raw.title).trim();
  const start =
    startTimeSeconds(raw) ??
    startTimeSeconds(raw.onTap) ??
    startTimeSeconds(raw.onTap?.watchEndpoint);
  if (start === undefined) return null;
  return { start, title };
}

function startTimeSeconds(node: unknown): number | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as YtNode;
  const direct = asNumber(n.startTimeSeconds);
  if (direct !== undefined) return direct;
  const we = n.watchEndpoint ?? n.onTap?.watchEndpoint ?? n.onTap?.innertubeCommand?.watchEndpoint;
  const fromWe = asNumber(we?.startTimeSeconds);
  if (fromWe !== undefined) return fromWe;
  if (n.onTap || n.innertubeCommand || n.watchEndpoint) {
    return (
      startTimeSeconds(n.onTap) ??
      startTimeSeconds(n.innertubeCommand) ??
      startTimeSeconds(n.watchEndpoint)
    );
  }
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function finalize(list: VideoChapter[]): VideoChapter[] | null {
  if (list.length < 2) return null;
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const deduped: VideoChapter[] = [];
  for (const ch of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.start === ch.start) {
      // Prefer the titled copy when the same instant appears twice.
      if (!prev.title && ch.title) prev.title = ch.title;
      continue;
    }
    deduped.push({ start: ch.start, title: ch.title });
  }
  if (deduped.length < 2) return null;
  // YouTube only promotes a description list that opens at 0:00. Official
  // markers already satisfy that; a regex parse of prose should too, or
  // "released at 3:00" + "ends 4:15" becomes two fake chapters.
  if (deduped[0].start > 1) return null;
  return deduped.map((ch, i) => ({
    start: ch.start,
    title: ch.title || `Chapter ${i + 1}`,
  }));
}

function walk(node: unknown, visit: (n: YtNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as YtNode;
  visit(n);
  for (const v of Object.values(n)) walk(v, visit);
}