import { describe, expect, it } from "vitest";
import { correctedDuration, shouldSkipOutro } from "@/lib/outro";

describe("shouldSkipOutro", () => {
  it("skips deep into a long dead tail (No Guidance 8:41, vocals end ~4:35)", () => {
    expect(shouldSkipOutro(275 + 61, 521, 275)).toBe(true);
    expect(shouldSkipOutro(430, 521, 275)).toBe(true);
  });

  it("waits out the grace period after the last line", () => {
    expect(shouldSkipOutro(275 + 30, 521, 275)).toBe(false);
  });

  it("leaves normal outros alone (Kaafizyada 5:28, vocals end 4:19)", () => {
    expect(shouldSkipOutro(320, 328, 259)).toBe(false);
    expect(shouldSkipOutro(327, 328, 259)).toBe(false);
  });

  it("does nothing without synced-lyrics data or sane durations", () => {
    expect(shouldSkipOutro(400, 521, null)).toBe(false);
    expect(shouldSkipOutro(400, 0, 275)).toBe(false);
    expect(shouldSkipOutro(400, 521, 600)).toBe(false);
  });
});

describe("correctedDuration", () => {
  it("collapses the doubled AVFoundation reading to the listed length", () => {
    expect(correctedDuration(223, 445.14)).toBe(223);
    expect(correctedDuration(261, 521.35)).toBe(261);
  });

  it("trusts the element when the ratio is not the 2x signature", () => {
    expect(correctedDuration(223, 224.9)).toBe(224.9);
    expect(correctedDuration(223, 700)).toBe(700);
    expect(correctedDuration(undefined, 445)).toBe(445);
    expect(correctedDuration(10, 21)).toBe(21);
  });
});
