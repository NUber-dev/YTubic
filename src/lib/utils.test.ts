import { describe, expect, it } from "vitest";
import { artistLineFromSubtitle } from "./utils";

describe("artistLineFromSubtitle", () => {
  it("returns plain artist strings unchanged", () => {
    expect(artistLineFromSubtitle("Sukha, Jassa Dhillon, & Chani Nattan")).toBe(
      "Sukha, Jassa Dhillon, & Chani Nattan",
    );
    expect(artistLineFromSubtitle("The Weeknd")).toBe("The Weeknd");
  });

  it("strips the type token and duration from decorated song rows", () => {
    expect(artistLineFromSubtitle("Song • Don Toliver • 3:47")).toBe(
      "Don Toliver",
    );
    expect(artistLineFromSubtitle("Video • Talwiinder • 4:02")).toBe(
      "Talwiinder",
    );
  });

  it("keeps the artist from album/year decorations", () => {
    expect(artistLineFromSubtitle("Album • AP Dhillon • 2021")).toBe(
      "AP Dhillon",
    );
    expect(artistLineFromSubtitle("Single • SZA • 2024")).toBe("SZA");
  });

  it("takes the artist segment, not the album, when both survive", () => {
    expect(
      artistLineFromSubtitle("Song • Don Toliver • Hardstone Psycho • 3:47"),
    ).toBe("Don Toliver");
  });

  it("returns empty for lines with no artist-like segment", () => {
    expect(artistLineFromSubtitle("3.4M views • 2 years ago")).toBe("");
    expect(artistLineFromSubtitle("Song • 3:47")).toBe("");
  });

  it("handles empty and undefined", () => {
    expect(artistLineFromSubtitle(undefined)).toBe("");
    expect(artistLineFromSubtitle("")).toBe("");
    expect(artistLineFromSubtitle("  ")).toBe("");
  });

  it("keeps multi-artist collab segments whole", () => {
    expect(
      artistLineFromSubtitle("Song • Kendrick Lamar, SZA • luther • 2:57"),
    ).toBe("Kendrick Lamar, SZA");
  });
});
