import { describe, expect, it } from "vitest";
import { scaleTimedLines } from "@/lib/lyrics/lrclib";
import { parseLRC } from "@/lib/lyrics/parse-lrc";

describe("parseLRC", () => {
  it("parses timestamped lines and fills end from the next start", () => {
    const lines = parseLRC("[00:10.00]first\n[00:12.50]second");
    expect(lines).toEqual([
      { start: 10, end: 12.5, text: "first" },
      { start: 12.5, text: "second" },
    ]);
  });

  it("handles 1/2/3-digit fractions", () => {
    const lines = parseLRC("[00:01.5]a\n[00:02.05]b\n[00:03.005]c");
    expect(lines.map((l) => l.start)).toEqual([1.5, 2.05, 3.005]);
  });

  it("expands multi-timestamp (chorus) lines", () => {
    const lines = parseLRC("[00:05.00][00:20.00]chorus");
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [5, "chorus"],
      [20, "chorus"],
    ]);
  });

  it("skips metadata-only lines", () => {
    const lines = parseLRC("[ar:Artist]\n[ti:Title]\n[00:01.00]real");
    expect(lines).toEqual([{ start: 1, text: "real" }]);
  });

  it("applies a positive [offset] by shifting lines earlier", () => {
    const lines = parseLRC("[offset:+500]\n[00:10.00]hi");
    expect(lines[0].start).toBeCloseTo(9.5, 5);
  });

  it("applies a negative [offset] by shifting lines later", () => {
    const lines = parseLRC("[offset:-500]\n[00:10.00]hi");
    expect(lines[0].start).toBeCloseTo(10.5, 5);
  });

  it("never produces a negative start", () => {
    const lines = parseLRC("[offset:+5000]\n[00:01.00]hi");
    expect(lines[0].start).toBe(0);
  });

  it("returns [] for empty / untimed input", () => {
    expect(parseLRC("")).toEqual([]);
    expect(parseLRC("no timestamps here")).toEqual([]);
  });
});

describe("scaleTimedLines", () => {
  const lines = [
    { start: 100, end: 110, text: "a" },
    { start: 110, text: "b" },
  ];
  it("rescales to a sped-up upload's listed length", () => {
    const out = scaleTimedLines(lines, 238, 179);
    expect(out[0].start).toBeCloseTo(100 * (179 / 238), 3);
    expect(out[0].end).toBeCloseTo(110 * (179 / 238), 3);
    expect(out[1].end).toBeUndefined();
  });
  it("leaves near-1 ratios and unknown durations alone", () => {
    expect(scaleTimedLines(lines, 238, 240)).toEqual(lines);
    expect(scaleTimedLines(lines, undefined, 179)).toEqual(lines);
    expect(scaleTimedLines(lines, 238, 30)).toEqual(lines);
  });
  it("refuses extreme ratios (different cut, not a tempo edit)", () => {
    expect(scaleTimedLines(lines, 238, 500)).toEqual(lines);
  });
});
