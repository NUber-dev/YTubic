import { describe, expect, it } from "vitest";
import { hitMatches, normalizeForMatch, tokenOverlap } from "@/lib/lyrics/match";

describe("normalizeForMatch", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeForMatch("Hello, World!")).toBe("hello world");
  });

  it("drops parentheticals and featurings", () => {
    expect(normalizeForMatch("Song (Remastered) feat. Someone")).toBe("song");
    expect(normalizeForMatch("Track [Live]")).toBe("track");
  });
});

describe("tokenOverlap", () => {
  it("is 1 for identical token sets and 0 for disjoint", () => {
    expect(tokenOverlap("a b", "a b")).toBe(1);
    expect(tokenOverlap("a b", "c d")).toBe(0);
  });

  it("is jaccard: shared over the union, so a subset is not a perfect match", () => {
    // one shared token out of three distinct -> 1/3, NOT 1. This is what
    // stops a different song credited to just "Sukha" matching the full
    // "Sukha, Prodgk & Tegi Pannu" on the one shared name.
    expect(tokenOverlap("a", "a b c")).toBeCloseTo(1 / 3);
  });
});

describe("hitMatches", () => {
  const norm = normalizeForMatch;

  it("accepts an exact title+artist match", () => {
    expect(
      hitMatches(norm("Bohemian Rhapsody"), norm("Queen"), norm("Bohemian Rhapsody"), norm("Queen")),
    ).toBe(true);
  });

  it("rejects a completely different song (the wrong-lyrics bug)", () => {
    expect(
      hitMatches(norm("Obscure Track"), norm("Small Artist"), norm("Blinding Lights"), norm("The Weeknd")),
    ).toBe(false);
  });

  it("rejects a title match with a mismatched artist", () => {
    expect(
      hitMatches(norm("Hello"), norm("Adele"), norm("Hello"), norm("Someone Else")),
    ).toBe(false);
  });

  it("matches title-only when the artist is unknown", () => {
    expect(hitMatches(norm("Yesterday"), "", norm("Yesterday"), norm("The Beatles"))).toBe(true);
  });

  it("tolerates featurings / parentheticals via normalization", () => {
    expect(
      hitMatches(norm("Blinding Lights"), norm("The Weeknd"), norm("Blinding Lights (Remix)"), norm("The Weeknd feat. X")),
    ).toBe(true);
  });

  it("rejects a different song by a same-named artist (ON SIGHT bug)", () => {
    // a wrong Punjabi track credited to just "Sukha" must not match a
    // request for "ON SIGHT" by "Sukha, Prodgk & Tegi Pannu"
    expect(
      hitMatches(norm("ON SIGHT"), norm("Sukha, Prodgk & Tegi Pannu"), norm("Billo"), norm("Sukha")),
    ).toBe(false);
  });

  it("accepts a collab track whose lyric db credits only the primary artist", () => {
    // exact title match relaxes the full-collaborator-list requirement
    expect(
      hitMatches(norm("B's on the Table"), norm("Drake, 21 Savage"), norm("B's on the Table"), norm("Drake")),
    ).toBe(true);
  });
});
