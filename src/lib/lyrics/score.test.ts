import { describe, expect, it } from "vitest";
import {
  scoreCandidate,
  selectBest,
  type ScoreCandidate,
  type ScoreQuery,
} from "@/lib/lyrics/score";

/**
 * The cases here are the ones live probing showed the old selector getting
 * wrong. Fixtures mirror real LRCLIB rows: the junk durations, the empty
 * string bodies and the duplicate rows are all shapes the API returns.
 *
 * The old rule was "keep records that have synced lyrics, then take the one
 * whose duration is closest". Every failure below is a way that loses.
 */

const SYNCED = "[00:01.00]la\n[03:00.00]la";
const PLAIN = "la la la";

function row(o: Partial<ScoreCandidate>): ScoreCandidate {
  return { plainLyrics: PLAIN, ...o };
}

describe("the remix that used to win", () => {
  // LRCLIB's top hit for this query is the Ariana Grande remix at 233s. The
  // original is 260s. Closest-duration alone gets it right only if the
  // duration is known and exact; the qualifier is what makes it robust.
  const candidates = [
    row({ trackName: "Die For You (Remix)", artistName: "The Weeknd & Ariana Grande", duration: 233, syncedLyrics: SYNCED }),
    row({ trackName: "Die For You", artistName: "The Weeknd", duration: 260, syncedLyrics: SYNCED }),
  ];

  it("picks the original for an unqualified request", () => {
    const q: ScoreQuery = { title: "Die For You", artist: "The Weeknd", durationSec: 260 };
    expect(selectBest(q, candidates)?.record.duration).toBe(260);
  });

  it("picks the remix when the remix was asked for", () => {
    const q: ScoreQuery = { title: "Die For You (Remix)", artist: "The Weeknd", durationSec: 233 };
    expect(selectBest(q, candidates)?.record.duration).toBe(233);
  });

  it("still prefers the original when the duration is unknown", () => {
    // The qualifier has to carry it alone here.
    const q: ScoreQuery = { title: "Die For You", artist: "The Weeknd" };
    expect(selectBest(q, candidates)?.record.duration).toBe(260);
  });
});

describe("qualifiers that must be ignored", () => {
  it("accepts a bare row for a remastered request", () => {
    // Every correct "Hotel California (2013 Remaster)" is 391s and bare in
    // LRCLIB. Treating the remaster tag as a version rejects the whole set.
    const q: ScoreQuery = { title: "Hotel California (2013 Remaster)", artist: "Eagles", durationSec: 391 };
    const best = selectBest(q, [
      row({ trackName: "Hotel California", artistName: "Eagles", duration: 206, syncedLyrics: SYNCED }),
      row({ trackName: "Hotel California", artistName: "Eagles", duration: 391, syncedLyrics: SYNCED }),
    ]);
    expect(best?.record.duration).toBe(391);
  });
});

describe("artist verification", () => {
  it("rejects a stranger with a perfect duration", () => {
    // Two unrelated songs called Sticky, sixteen seconds apart. Duration
    // must never outvote the artist.
    const q: ScoreQuery = { title: "Sticky", artist: "Tyler, The Creator", durationSec: 256 };
    const best = selectBest(q, [
      row({ trackName: "Sticky", artistName: "Drake", duration: 256, syncedLyrics: SYNCED }),
    ]);
    expect(best).toBeNull();
  });

  it("accepts a subset credit, which is the common correct form", () => {
    const q: ScoreQuery = { title: "Rich Flex", artist: "Drake, 21 Savage", durationSec: 239 };
    const best = selectBest(q, [
      row({ trackName: "Rich Flex", artistName: "Drake", duration: 239, syncedLyrics: SYNCED }),
    ]);
    expect(best).not.toBeNull();
  });

  it("outranks a truncated credit rather than rejecting it", () => {
    // "Linkin" is a distinct artist LRCLIB returns at rank 0.
    const q: ScoreQuery = { title: "Numb", artist: "Linkin Park", durationSec: 187 };
    const best = selectBest(q, [
      row({ trackName: "Numb", artistName: "Linkin", duration: 185, syncedLyrics: SYNCED }),
      row({ trackName: "Numb (Numb)", artistName: "Linkin Park", duration: 187, syncedLyrics: SYNCED }),
    ]);
    expect(best?.record.artistName).toBe("Linkin Park");
  });
});

describe("refusing rather than guessing", () => {
  it("refuses a generic title with no artist", () => {
    // Bare "Stay" returns twelve rows, all Taylor Swift's "Stay Stay Stay".
    const q: ScoreQuery = { title: "Stay", durationSec: 240 };
    expect(
      selectBest(q, [row({ trackName: "Stay Stay Stay", artistName: "Taylor Swift", duration: 238, syncedLyrics: SYNCED })]),
    ).toBeNull();
  });

  it("refuses when artist-less candidates disagree about who performed it", () => {
    // A one-second margin between a cover and the original is inside
    // LRCLIB's own variance for a single recording.
    const q: ScoreQuery = { title: "Blinding Lights", durationSec: 200 };
    expect(
      selectBest(q, [
        row({ trackName: "Blinding Lights", artistName: "The Weeknd", duration: 200, syncedLyrics: SYNCED }),
        row({ trackName: "Blinding Lights", artistName: "Teddy Swims", duration: 199, syncedLyrics: SYNCED }),
      ]),
    ).toBeNull();
  });

  it("refuses everything from an artist-less retry", () => {
    const q: ScoreQuery = { title: "Alone", artist: undefined, durationSec: 274, artistWasDropped: true };
    expect(
      selectBest(q, [row({ trackName: "Alone", artistName: "Parkway Drive", duration: 271, syncedLyrics: SYNCED })]),
    ).toBeNull();
  });

  it("still answers when the title and artist are right but every duration is far off", () => {
    // Twenty EARFQUAKE rows credited to Tyler, none near the real 190s.
    //
    // The design this was built from wanted the confidence floor to reject
    // this set. It cannot, and the two constants are in direct tension: the
    // `0.55 + 0.45 x duration` envelope means a perfect title and artist
    // floors the score at exactly 0.55, which is the floor itself. Rather
    // than tune one to make the other bite, note that rejecting here would
    // be the wrong call anyway: a duration mismatch on the right song
    // affects the timings, not the words, and R7 already suppresses an LRC
    // that overruns. Showing the right words beats showing nothing.
    //
    // Wrong *songs* are rejected on their own axes (artist, identity, the
    // artist-less disagreement rule), not by this floor.
    const q: ScoreQuery = { title: "EARFQUAKE", artist: "Tyler, The Creator", durationSec: 190 };
    const best = selectBest(
      q,
      [225, 240, 255, 271].map((d) =>
        row({ trackName: "EARFQUAKE", artistName: "Tyler, The Creator", duration: d, syncedLyrics: SYNCED }),
      ),
    );
    expect(best).not.toBeNull();
    // The nearest one, and the score sits just above the floor.
    expect(best?.record.duration).toBe(225);
    expect(best?.verdict.score).toBeLessThan(0.65);
  });

  it("does reject once the artist itself is degraded", () => {
    // Where the floor genuinely bites: an unrequested extra credit drops
    // the artist factor, and a poor duration then takes it under.
    const q: ScoreQuery = { title: "Levitating", artist: "Dua Lipa", durationSec: 203 };
    expect(
      selectBest(q, [
        row({ trackName: "Levitating", artistName: "Dua Lipa, DaBaby", duration: 240, syncedLyrics: SYNCED }),
      ]),
    ).toBeNull();
  });
});

describe("the gates, exercised where nothing else masks them", () => {
  // Both of these were written after mutation testing showed the existing
  // cases never reached these two rules: an obviously-wrong candidate fails
  // several checks at once, so no single one of them was actually pinned.

  it("rejects a near-miss title by the same artist at the same duration", () => {
    // IU has both of these. Identity is 0.750, which is the measured
    // ceiling for a stranger and the reason the floor sits at 0.85. Every
    // other signal here is perfect, so nothing else can reject it.
    const q: ScoreQuery = { title: "좋은 날", artist: "아이유", durationSec: 219 };
    const v = scoreCandidate(
      q,
      row({ trackName: "운수 좋은 날", artistName: "아이유", duration: 219, syncedLyrics: SYNCED }),
    );
    expect(v.reject).toBe(true);
    expect(v.reason).toMatch(/identity/);
  });

  it("rejects on the artist gate specifically, not merely on the total", () => {
    // A collaboration we did not ask for scores 0.30. The product would
    // fail the confidence floor anyway, so assert the reason: that is what
    // distinguishes the gate from the floor, and what a mutation removing
    // the gate would change.
    const q: ScoreQuery = { title: "Levitating", artist: "Dua Lipa", durationSec: 203 };
    const v = scoreCandidate(
      q,
      row({
        trackName: "Levitating",
        artistName: "Dua Lipa, DaBaby, Migos, Someone Else",
        duration: 203,
        syncedLyrics: SYNCED,
      }),
    );
    expect(v.reject).toBe(true);
    expect(v.reason).toMatch(/artist score/);
  });
});

describe("bodies", () => {
  it("skips a record whose fields are empty strings", () => {
    // Three 밤편지 rows carry syncedLyrics: "" and plainLyrics: "".
    const q: ScoreQuery = { title: "밤편지", artist: "아이유", durationSec: 253 };
    const best = selectBest(q, [
      row({ trackName: "밤편지 (Through the Night)", artistName: "아이유", duration: 253, syncedLyrics: "", plainLyrics: "" }),
      row({ trackName: "밤편지", artistName: "아이유", duration: 253, syncedLyrics: SYNCED }),
    ]);
    expect(best?.record.syncedLyrics).toBe(SYNCED);
  });

  it("accepts a plain-only set instead of returning empty", () => {
    // Postmodern Jukebox's Creep: eight correct rows, none synced. The old
    // synced pre-filter returned nothing here.
    const q: ScoreQuery = { title: "Creep", artist: "Postmodern Jukebox", durationSec: 247 };
    const best = selectBest(q, [
      row({ trackName: "Creep", artistName: "Postmodern Jukebox", duration: 247, syncedLyrics: null }),
    ]);
    expect(best).not.toBeNull();
    expect(best?.verdict.suppressSynced).toBe(false);
  });

  it("suppresses an LRC that runs past the end of the audio", () => {
    // A radio edit's row carries the full-length body: zero duration delta,
    // 68 seconds of lyrics after the song stops.
    const q: ScoreQuery = { title: "Get Lucky", artist: "Daft Punk", durationSec: 248 };
    const best = selectBest(q, [
      row({ trackName: "Get Lucky", artistName: "Daft Punk", duration: 248, syncedLyrics: "[00:01.00]a\n[05:15.71]b" }),
    ]);
    expect(best?.verdict.suppressSynced).toBe(true);
  });

  it("rejects an overrunning LRC when there is no plain text to fall back on", () => {
    const q: ScoreQuery = { title: "Get Lucky", artist: "Daft Punk", durationSec: 248 };
    expect(
      selectBest(q, [
        { trackName: "Get Lucky", artistName: "Daft Punk", duration: 248, syncedLyrics: "[05:15.71]b", plainLyrics: null },
      ]),
    ).toBeNull();
  });
});

describe("durations that lie", () => {
  it("keeps a record with a junk duration rather than dropping the record", () => {
    // A 3s row can still carry a complete correct body.
    const q: ScoreQuery = { title: "bad guy", artist: "Billie Eilish", durationSec: 194 };
    const best = selectBest(q, [row({ trackName: "bad guy", artistName: "Billie Eilish", duration: 3, syncedLyrics: SYNCED })]);
    expect(best).not.toBeNull();
  });

  it("rejects a candidate far longer than the audio", () => {
    const q: ScoreQuery = { title: "Sweater Weather", artist: "The Neighbourhood", durationSec: 240 };
    expect(
      selectBest(q, [row({ trackName: "Sweater Weather", artistName: "The Neighbourhood", duration: 694, syncedLyrics: SYNCED })]),
    ).toBeNull();
  });

  it("does not produce NaN when a duration is missing", () => {
    const q: ScoreQuery = { title: "Sweater Weather", artist: "The Neighbourhood", durationSec: 240 };
    const v = scoreCandidate(q, row({ trackName: "Sweater Weather", artistName: "The Neighbourhood", duration: null }));
    expect(Number.isFinite(v.score)).toBe(true);
  });
});

describe("titles the provider mangled", () => {
  it("matches a row with the artist and furniture baked into the title", () => {
    const q: ScoreQuery = { title: "Alone", artist: "Marshmello", durationSec: 264 };
    const best = selectBest(q, [
      row({ trackName: "Marshmello - Alone (Official Music Video)", artistName: "Marshmello", duration: 264, syncedLyrics: SYNCED }),
    ]);
    expect(best).not.toBeNull();
  });

  it("matches a self-joined title", () => {
    const q: ScoreQuery = { title: "One Kiss", artist: "Calvin Harris, Dua Lipa", durationSec: 214 };
    const best = selectBest(q, [
      row({ trackName: "One Kiss;One Kiss", artistName: "Calvin Harris & Dua Lipa", duration: 214, syncedLyrics: SYNCED }),
    ]);
    expect(best).not.toBeNull();
  });
});

describe("cross-script", () => {
  it("accepts a transliterated title when the artist carries it", () => {
    const q: ScoreQuery = { title: "Группа крови", artist: "Кино", durationSec: 286 };
    const best = selectBest(q, [
      row({ trackName: "Gruppa Krovi", artistName: "Кино", duration: 286, syncedLyrics: SYNCED }),
    ]);
    expect(best).not.toBeNull();
  });

  it("refuses a transliterated title when the artist does not agree", () => {
    const q: ScoreQuery = { title: "Группа крови", artist: "Кино", durationSec: 286 };
    expect(
      selectBest(q, [row({ trackName: "Gruppa Krovi", artistName: "Some Cover Band", duration: 286, syncedLyrics: SYNCED })]),
    ).toBeNull();
  });
});

describe("providers with fewer signals", () => {
  it("scores on title and artist alone when the body is not fetched yet", () => {
    // Musixmatch and Genius decide which track to fetch from search
    // metadata; only LRCLIB returns bodies inline.
    const q: ScoreQuery = { title: "Blinding Lights", artist: "The Weeknd" };
    const best = selectBest(
      q,
      [
        { trackName: "Blinding Lights", artistName: "Teddy Swims" },
        { trackName: "Blinding Lights", artistName: "The Weeknd" },
      ],
      { durationBlind: true, bodyUnknown: true },
    );
    expect(best?.record.artistName).toBe("The Weeknd");
  });

  it("applies a higher floor when duration is unavailable", () => {
    const q: ScoreQuery = { title: "Numb", artist: "Linkin Park" };
    // A truncated credit alone, with no duration to corroborate it, does
    // not clear the raised floor.
    expect(
      selectBest(q, [{ trackName: "Numb", artistName: "Linkin" }], {
        durationBlind: true,
        bodyUnknown: true,
      }),
    ).toBeNull();
  });
});

describe("grouping", () => {
  it("collapses duplicate rows of one body and picks the modal duration", () => {
    // Twenty rows routinely carry one or two distinct bodies; choosing
    // among clones by duration is theatre, so the crowd's modal value wins.
    const q: ScoreQuery = { title: "bad guy", artist: "Billie Eilish", durationSec: 194 };
    const best = selectBest(q, [
      row({ trackName: "bad guy", artistName: "Billie Eilish", duration: 190, syncedLyrics: SYNCED }),
      row({ trackName: "bad guy", artistName: "Billie Eilish", duration: 194, syncedLyrics: SYNCED }),
      row({ trackName: "bad guy", artistName: "Billie Eilish", duration: 194, syncedLyrics: SYNCED }),
    ]);
    expect(best?.record.duration).toBe(194);
  });
});
