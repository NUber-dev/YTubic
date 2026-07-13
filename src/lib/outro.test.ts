import { describe, expect, it } from "vitest";
import { shouldSkipOutro } from "@/lib/outro";

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
