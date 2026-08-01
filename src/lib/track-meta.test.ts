import { describe, expect, it } from "vitest";
import {
  artistFromSubtitle,
  artistsFromList,
  cleanTrackTitle,
  lyricsArtist,
  reattributedFromTitle,
  stripTopicSuffix,
} from "./track-meta";

describe("cleanTrackTitle", () => {
  it("drops upload furniture that costs the whole result set", () => {
    // Measured: this exact title returns 0 LRCLIB hits, the bare one 20.
    expect(cleanTrackTitle("Blinding Lights (Official Music Video)")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Blinding Lights [Official Video]")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Levitating (Official Audio)")).toBe("Levitating");
    expect(cleanTrackTitle("Something (Visualizer)")).toBe("Something");
    expect(cleanTrackTitle("Something (Lyrics)")).toBe("Something");
    expect(cleanTrackTitle("Something (4K)")).toBe("Something");
  });

  it("handles the CJK bracket families NFKC leaves alone", () => {
    // Measured: 【MV】 takes YOASOBI's アイドル from 20 hits to 0.
    expect(cleanTrackTitle("アイドル【MV】")).toBe("アイドル");
    expect(cleanTrackTitle("アイドル（Official Music Video）")).toBe("アイドル");
    expect(cleanTrackTitle("좋은 날「가사」")).toBe("좋은 날");
  });

  it("drops featuring credits, which the artist field already carries", () => {
    expect(cleanTrackTitle("Die For You (feat. Ariana Grande)")).toBe(
      "Die For You",
    );
    expect(cleanTrackTitle("Industry Baby (ft. Jack Harlow)")).toBe(
      "Industry Baby",
    );
    expect(cleanTrackTitle("Track (prod. by Metro Boomin)")).toBe("Track");
  });

  it("keeps version qualifiers, which identify the recording", () => {
    // Stripping these would make a remix indistinguishable from its
    // original, and they cost nothing at search time (20 hits either way).
    for (const t of [
      "Die For You (Remix)",
      "Faded (Restrung)",
      "Hotel California (Remastered 2013)",
      "Creep (Acoustic Version)",
      "Bohemian Rhapsody (Live at Wembley)",
      "Song (Sped Up)",
    ]) {
      expect(cleanTrackTitle(t)).toBe(t);
    }
  });

  it("does not mistake a parenthetical title for a credit", () => {
    // "with" reads as a credit in "(with Ariana Grande)" and as part of the
    // name here, and losing a real title is the worse error.
    expect(cleanTrackTitle("Stay (With Me)")).toBe("Stay (With Me)");
    expect(cleanTrackTitle("Dancing With A Stranger")).toBe(
      "Dancing With A Stranger",
    );
  });

  it("removes only the noisy bracket when several are present", () => {
    expect(cleanTrackTitle("Song (Official Video) (Remix)")).toBe(
      "Song (Remix)",
    );
    expect(cleanTrackTitle("Song (feat. X) (Live)")).toBe("Song (Live)");
  });

  it("strips trailing hyphen-separated furniture", () => {
    expect(cleanTrackTitle("Blinding Lights - Official Video")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Blinding Lights | Official Audio")).toBe(
      "Blinding Lights",
    );
  });

  it("never returns an empty title", () => {
    // A track genuinely called "Audio" must still be looked up.
    expect(cleanTrackTitle("Audio")).toBe("Audio");
    expect(cleanTrackTitle("(Official Video)")).toBe("(Official Video)");
    expect(cleanTrackTitle("")).toBe("");
  });

  it("leaves an unbalanced bracket alone rather than eating the title", () => {
    expect(cleanTrackTitle("Song (Official Video")).toBe(
      "Song (Official Video",
    );
  });

  it("folds fullwidth latin so the query matches", () => {
    expect(cleanTrackTitle("Ｂｌｉｎｄｉｎｇ　Ｌｉｇｈｔｓ")).toBe(
      "Blinding Lights",
    );
  });
});

describe("stripTopicSuffix", () => {
  it("removes the auto-generated channel suffix", () => {
    // Measured: "The Weeknd - Topic" takes 20 LRCLIB hits down to 1.
    expect(stripTopicSuffix("The Weeknd - Topic")).toBe("The Weeknd");
    expect(stripTopicSuffix("YOASOBI - Topic")).toBe("YOASOBI");
  });

  it("leaves a real name containing a hyphen intact", () => {
    expect(stripTopicSuffix("Jay-Z")).toBe("Jay-Z");
    expect(stripTopicSuffix("Anne-Marie")).toBe("Anne-Marie");
  });
});

describe("artistFromSubtitle", () => {
  it("pulls the name out of the breadcrumb", () => {
    // Measured: the raw breadcrumb scores 1 hit, or 0 with a view count.
    expect(artistFromSubtitle("Song • The Weeknd")).toBe("The Weeknd");
    expect(artistFromSubtitle("Video • The Weeknd • 1B views")).toBe(
      "The Weeknd",
    );
    expect(artistFromSubtitle("Song • Don Toliver • 3:47")).toBe("Don Toliver");
    expect(artistFromSubtitle("Album • The Weeknd")).toBe("The Weeknd");
  });

  it("returns undefined when the line holds no name at all", () => {
    // Better no artist than a decorated string no provider can match.
    expect(artistFromSubtitle("Artist • 224M monthly audience")).toBeUndefined();
    expect(artistFromSubtitle("Song • 3:47")).toBeUndefined();
    expect(artistFromSubtitle(undefined)).toBeUndefined();
    expect(artistFromSubtitle("")).toBeUndefined();
  });

  it("only treats a type word as furniture in the leading position", () => {
    // "Song" is also a band name.
    expect(artistFromSubtitle("Song • Song")).toBe("Song");
  });

  it("strips the Topic suffix it finds in the breadcrumb", () => {
    expect(artistFromSubtitle("Song • The Weeknd - Topic")).toBe("The Weeknd");
  });
});

describe("lyricsArtist", () => {
  it("prefers the structured list and joins it", () => {
    // Measured: joining costs nothing (20 hits either way), so keeping
    // every credited name is free insurance against the database crediting
    // the one we would have dropped.
    expect(
      lyricsArtist({
        artists: [{ name: "The Weeknd" }, { name: "Ariana Grande" }],
        subtitle: "Song • Whatever",
      }),
    ).toBe("The Weeknd, Ariana Grande");
  });

  it("falls back to the subtitle when there is no list", () => {
    expect(lyricsArtist({ subtitle: "Video • Don Toliver • 12M views" })).toBe(
      "Don Toliver",
    );
  });

  it("is undefined when neither source yields a name", () => {
    expect(lyricsArtist({ subtitle: "Artist • 3M subscribers" })).toBeUndefined();
    expect(lyricsArtist({})).toBeUndefined();
    expect(lyricsArtist(undefined)).toBeUndefined();
  });

  it("de-Topics the structured list too", () => {
    expect(artistsFromList([{ name: "YOASOBI - Topic" }])).toBe("YOASOBI");
  });
});

describe("reattributedFromTitle", () => {
  it("recovers a re-upload that hid the artist in the title", () => {
    // Reported case: "Скриптонит - Жить как я живу (flac)" uploaded by a
    // channel called "Skrypto gramma". As sent, zero results anywhere; as
    // re-attributed, an ordinary track with six records.
    expect(
      reattributedFromTitle("Скриптонит - Жить как я живу", "Skrypto gramma"),
    ).toEqual({ title: "Жить как я живу", artist: "Скриптонит" });
  });

  it("declines when the credited artist is already in the title", () => {
    // Then the ordinary reading was right and there is nothing to recover.
    expect(
      reattributedFromTitle("Marshmello - Alone", "Marshmello"),
    ).toBeNull();
  });

  it("declines on anything that is not a two-part split", () => {
    expect(reattributedFromTitle("Blinding Lights", "The Weeknd")).toBeNull();
    expect(
      reattributedFromTitle("Levels - Avicii - Levels", "Avicii"),
    ).toBeNull();
  });
});

describe("cleanTrackTitle audio-quality tags", () => {
  it("drops the format tags re-uploads carry", () => {
    expect(cleanTrackTitle("Жить как я живу (flac)")).toBe("Жить как я живу");
    expect(cleanTrackTitle("Song (320kbps)")).toBe("Song");
    expect(cleanTrackTitle("Song [Lossless]")).toBe("Song");
  });
});
