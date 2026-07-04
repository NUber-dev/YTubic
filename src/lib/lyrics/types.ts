/**
 * A single line of synchronized lyrics.
 *
 * `start` is the second at which the line becomes active; `end` is when it
 * stops being active. Some lines have no text ("interlude" markers) — we
 * still render them so the highlight glides naturally.
 */
export type TimedLine = {
  start: number;
  end?: number;
  text: string;
};

export type Lyrics =
  | { kind: "timed"; lines: TimedLine[]; source?: string }
  | { kind: "plain"; text: string; source?: string };
