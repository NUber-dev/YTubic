import type { TimedLine } from "@/lib/lyrics/types";

/**
 * Parse LRC text into timed lines.
 *
 * Format examples:
 *   [00:12.34]First line
 *   [00:15.67]Second line
 *   [00:15.67][00:20.00]Repeated line (chorus)
 *   [00:12]Line without centiseconds
 *
 * Lines without timestamps (metadata like `[ar:Artist]`) are skipped.
 * Each line's `end` is filled from the next line's `start` so the
 * highlight glides naturally between lines.
 */
export function parseLRC(lrc: string): TimedLine[] {
  const tsRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  const out: TimedLine[] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(tsRe)];
    if (matches.length === 0) continue;
    const last = matches[matches.length - 1];
    const text = rawLine.slice((last.index ?? 0) + last[0].length).trim();
    for (const m of matches) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const frac = m[3]
        ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10)
        : 0;
      if (Number.isNaN(mm) || Number.isNaN(ss)) continue;
      out.push({ start: mm * 60 + ss + frac / 1000, text });
    }
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length - 1; i++) {
    out[i].end = out[i + 1].start;
  }
  return out;
}
