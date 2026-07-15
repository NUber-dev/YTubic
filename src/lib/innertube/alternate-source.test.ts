import { describe, expect, it } from "vitest";
import { cleanAudioSwapOk } from "@/lib/innertube/alternate-source";

describe("cleanAudioSwapOk", () => {
  it("rescues a clearly-extended song row (the 7:45 remix case)", () => {
    // 465s extended upload vs the 232s album version
    expect(cleanAudioSwapOk("song", 465, 232)).toBe(true);
    expect(cleanAudioSwapOk(undefined, 465, 232)).toBe(true);
  });

  it("leaves near-equal song rows alone (no version ping-pong)", () => {
    expect(cleanAudioSwapOk("song", 240, 232)).toBe(false);
    expect(cleanAudioSwapOk("song", 232, 240)).toBe(false);
  });

  it("video rows accept the album version even when near-equal", () => {
    expect(cleanAudioSwapOk("video", 245, 232)).toBe(true);
    expect(cleanAudioSwapOk("video", 232, 245)).toBe(true);
    // but not a much longer 'song'
    expect(cleanAudioSwapOk("video", 232, 465)).toBe(false);
  });

  it("never swaps without duration data or onto a stub", () => {
    expect(cleanAudioSwapOk("song", undefined, 232)).toBe(false);
    expect(cleanAudioSwapOk("song", 465, undefined)).toBe(false);
    expect(cleanAudioSwapOk("song", 465, 45)).toBe(false);
  });
});
