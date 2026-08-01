import { describe, expect, it } from "vitest";
import {
  artistScore,
  collapseSelfJoin,
  dice,
  durationScore,
  foldSpecialLatin,
  lastTimestamp,
  normalizeForScore,
  parseTitle,
  qualifierFactor,
  titleIdentity,
  tokenOverlap,
} from "@/lib/lyrics/match";

/**
 * Three assertions in the previous version of this file pinned behaviour
 * that the live probes then showed to be wrong. They are inverted below and
 * labelled, because a test that encodes a bug quietly becomes the bug's
 * defence during a rewrite.
 */

describe("parseTitle", () => {
  it("INVERTED: keeps a version qualifier instead of deleting it", () => {
    // Was: normalizeForMatch("Track [Live]") === "track", i.e. the
    // qualifier vanished and a live take became an acceptable answer for a
    // studio request. "Die For You" and its remix are 27s apart and were
    // indistinguishable under that rule.
    const t = parseTitle("Track [Live]");
    expect(t.base).toBe("Track");
    expect(t.qualifiers).toEqual([{ text: "Live", cls: "hard" }]);
  });

  it("RE-EXPRESSED: a remaster is recognised, then ignored, not deleted", () => {
    // Was: normalizeForMatch("Song (Remastered) feat. Someone") === "song".
    // The outcome is the same but the qualifier now has to be classified,
    // so a future change cannot silently start deleting the hard ones too.
    const t = parseTitle("Song (Remastered)");
    expect(t.base).toBe("Song");
    expect(t.qualifiers).toEqual([{ text: "Remastered", cls: "soft" }]);
  });

  it("keeps a cross-script bracket as an alternative title", () => {
    // The only LRCLIB record for IU's 밤편지 is titled
    // "Through the Night (밤편지)". Deleting the parenthetical left
    // "through the night", sharing zero characters with the request.
    const t = parseTitle("Through the Night (밤편지)");
    expect(t.alts).toContain("밤편지");
  });

  it("drops a same-script echo bracket as noise", () => {
    expect(parseTitle("Numb (Numb)").alts).toEqual([]);
  });

  it("treats an unbalanced bracket as a qualifier body", () => {
    // "Sticky (feat. GloRilla, Sexyy Red" is a real, correct row.
    expect(parseTitle("Sticky (feat. GloRilla, Sexyy Red").base).toBe("Sticky");
  });

  it("reads the dash form of a qualifier", () => {
    const t = parseTitle("Hotel California - 2013 Remaster");
    expect(t.base).toBe("Hotel California");
    expect(t.qualifiers[0].cls).toBe("soft");
  });

  it("strips an upload id and a baked-in artist name", () => {
    expect(parseTitle("Alone_264023874", "Marshmello").base).toBe("Alone");
    expect(parseTitle("Marshmello - Alone", "Marshmello").base).toBe("Alone");
    expect(parseTitle("Levels - Avicii - Levels", "Avicii").base).toBe("Levels");
  });
});

describe("collapseSelfJoin", () => {
  it("collapses the separators providers actually use", () => {
    expect(collapseSelfJoin("HurtHurt")).toBe("Hurt");
    expect(collapseSelfJoin("One Kiss;One Kiss")).toBe("One Kiss");
  });

  it("leaves a genuinely repetitive title alone", () => {
    // Collapsing repeated words in general merges these into the titles
    // they must stay distinct from.
    for (const t of ["Stay Stay Stay", "Go Go Go Go", "ALONE ALONE ALONE"]) {
      expect(collapseSelfJoin(t)).toBe(t);
    }
  });
});

describe("dice", () => {
  it("separates a different song from a casing variant", () => {
    // Token overlap returns 1.000 for both of these.
    expect(dice("Звезда по имени Солнце", "Звезда")).toBeCloseTo(0.385, 2);
    expect(dice("Звезда по имени Солнце", "Звезда По Имени Солнце")).toBe(1);
  });

  it("is length-sensitive, which token overlap is not", () => {
    expect(dice("Stay", "Stay Stay Stay")).toBeCloseTo(0.375, 2);
    expect(tokenOverlap("stay", "stay stay stay")).toBe(1);
  });

  it("gives simplified and traditional Han a usable middle score", () => {
    expect(dice("周杰伦", "周杰倫")).toBeCloseTo(0.5, 2);
    expect(dice("周杰伦", "林俊杰")).toBe(0);
  });

  it("matches a romanized Cyrillic name instead of scoring it 0", () => {
    // The databases store Cyrillic acts romanized about as often as not,
    // and for Скриптонит the romanized rows are the ones carrying timings.
    // A raw comparison reads 0 here, which looks like a different artist.
    expect(dice("Группа крови", "Gruppa Krovi")).toBeGreaterThan(0.9);
    expect(dice("Скриптонит", "Skryptonite")).toBeGreaterThan(0.7);
    expect(dice("Земфира", "Zemfira")).toBe(1);
  });

  it("does not let romanization introduce false matches", () => {
    expect(dice("Скриптонит", "Oxxxymiron")).toBeLessThan(0.45);
    expect(dice("Кино", "Nirvana")).toBe(0);
    // The uploader channel name for the reported track. Must stay rejected,
    // or the re-attribution fallback would validate the wrong reading.
    expect(dice("Скриптонит", "Skrypto gramma")).toBeLessThan(0.45);
  });

  it("still returns 0 where no romanization applies", () => {
    // Japanese against an English title shares nothing, and callers must
    // read that as uninformative rather than as a mismatch.
    expect(dice("アイドル", "Idol")).toBe(0);
  });
});

describe("foldSpecialLatin", () => {
  it("handles the letters NFD does not decompose", () => {
    // "Høld On" is a real correctly timed row; without the fold it scores
    // 0.857 and loses to worse candidates.
    expect(normalizeForScore("Høld On")).toBe("hold on");
    expect(dice("Hold On", "Høld On")).toBe(1);
    // foldSpecialLatin handles only the letters NFD cannot; the a-ring
    // is left for normalizeForScore's NFD pass.
    expect(foldSpecialLatin("Blåhaj ß")).toBe("Blåhaj ss");
    expect(normalizeForScore("Blåhaj ß")).toBe("blahaj ss");
  });
});

describe("titleIdentity", () => {
  it("matches a cross-script alternative title", () => {
    expect(
      titleIdentity(parseTitle("밤편지"), parseTitle("Through the Night (밤편지)")),
    ).toBe(1);
  });

  it("does NOT let a same-script bracket rescue a stranger", () => {
    // Unguarded variant matching lifts this to 1.000 and would accept a
    // completely different song.
    expect(
      titleIdentity(parseTitle("Hurt"), parseTitle("Hurt Niggas (Hurt)")),
    ).toBeLessThan(0.85);
  });
});

describe("qualifierFactor", () => {
  it("INVERTED: a remix is no longer an acceptable match for the original", () => {
    // Was: hitMatches("blinding lights", ..., "blinding lights remix", ...)
    // === true. Refuted by "Die For You", where the original is 260s and
    // the remix 233s, and by a live take outranking the studio cut by
    // seven tenths of a second.
    const f = qualifierFactor(
      parseTitle("Die For You"),
      parseTitle("Die For You (Remix)"),
    );
    expect(f).toBeLessThan(0.6);
  });

  it("ignores a remaster, because the correct rows are unqualified", () => {
    // Every correct "Hotel California (2013 Remaster)" is 391s, identical
    // to the bare studio rows, and a plain search returns zero
    // remaster-tagged titles. Penalizing this rejects the whole set.
    expect(
      qualifierFactor(
        parseTitle("Hotel California (2013 Remaster)"),
        parseTitle("Hotel California"),
      ),
    ).toBe(1);
  });

  it("downranks rather than vetoes a missing qualifier", () => {
    // Every Metallica live take has a completely bare title.
    const f = qualifierFactor(
      parseTitle("Nothing Else Matters (Live)"),
      parseTitle("Nothing Else Matters"),
    );
    expect(f).toBeGreaterThan(0.6);
    expect(f).toBeLessThan(1);
  });
});

describe("artistScore", () => {
  it("RE-SCOPED: subset credits are free, which is the artist semantic", () => {
    // tokenOverlap's smaller-set denominator is correct HERE and wrong for
    // titles. The databases store the surviving credit as the first, the
    // last, or a middle name with no pattern.
    expect(artistScore("Drake, 21 Savage", "Drake", 0)).toBe(1);
    expect(artistScore("DJ Khaled, Rihanna, Bryson Tiller", "Rihanna", 0)).toBe(1);
    expect(artistScore("Tyler, The Creator", "The Creator", 0)).toBe(1);
  });

  it("survives every separator encoding one credit appears in", () => {
    for (const hit of [
      "Drake & 21 Savage",
      "Drake, 21 Savage",
      "Drake;21 Savage",
      "Drake／21 Savage",
      "Drake\\, 21 Savage",
    ]) {
      expect(artistScore("Drake, 21 Savage", hit, 0)).toBeGreaterThan(0.9);
    }
  });

  it("does not split a name that contains a separator", () => {
    expect(artistScore("Earth, Wind & Fire", "Earth, Wind", 0)).toBe(1);
    expect(
      artistScore(
        "Dimitri Vegas & Like Mike, Martin Garrix",
        "Dimitri Vegas & Like Mike & Martin Garrix",
        0,
      ),
    ).toBe(1);
  });

  it("is order-insensitive", () => {
    expect(artistScore("Dean Martin", "Martin, Dean", 0)).toBe(1);
  });

  it("rejects a stranger", () => {
    expect(artistScore("Marshmello", "Parkway Drive", 0)).toBe(0);
    expect(artistScore("The Weeknd", "Teddy Swims", 0)).toBe(0);
  });

  it("demotes an unrequested extra credit", () => {
    expect(artistScore("Dua Lipa", "Dua Lipa, DaBaby", 0)).toBeLessThan(0.8);
  });

  it("demotes a truncated credit below the untruncated rows", () => {
    // "Linkin" is a distinct artist that LRCLIB returns at rank 0 for a
    // Linkin Park query. It cannot be rejected outright, only outranked.
    const truncated = artistScore("Linkin Park", "Linkin", 2);
    expect(truncated).toBeLessThan(artistScore("Linkin Park", "Linkin Park", 2));
    expect(truncated).toBeGreaterThan(0.45);
  });
});

describe("durationScore", () => {
  it("decays smoothly rather than cutting off", () => {
    // No hard window works: the same recording spreads over 386-395s while
    // genuinely different versions sit 4s apart.
    expect(durationScore(0)).toBe(1);
    expect(durationScore(2)).toBeCloseTo(0.973, 2);
    expect(durationScore(12)).toBeCloseTo(0.5, 2);
    expect(durationScore(30)).toBeCloseTo(0.138, 2);
  });

  it("treats an unknown delta as weak evidence, not as zero or NaN", () => {
    expect(durationScore(null)).toBe(0.3);
    expect(durationScore(undefined)).toBe(0.3);
    expect(durationScore(NaN)).toBe(0.3);
  });
});

describe("lastTimestamp", () => {
  it("reports where the final timed line falls", () => {
    expect(lastTimestamp("[00:01.00]a\n[01:05.50]b")).toBeCloseTo(65.5, 2);
    expect(lastTimestamp("")).toBeNull();
    expect(lastTimestamp(null)).toBeNull();
  });
});

describe("romanization skeleton", () => {
  it("scores a spelling variant of one name as the same name", () => {
    // Reported track: the synced records are filed under "Skryptonite" and
    // "Scriptonite" while the plain ones spell it exactly. At 0.737 the
    // exact plain rows win and the timings are lost, which is not a doubt
    // about who the artist is, only about how it is transcribed.
    expect(dice("Скриптонит", "Skryptonite")).toBe(1);
    expect(dice("Скриптонит", "Scriptonite")).toBe(1);
    expect(dice("Океан Ельзи", "Okean Elzy")).toBe(1);
    expect(dice("Пошлая Молли", "Poshlaya Molly")).toBe(1);
  });

  it("promotes only on a near-exact skeleton, so near-misses stay near-misses", () => {
    // Both of these skeleton above 0.5 and would pass the artist gate if
    // the skeleton were trusted outright. They keep their lower score.
    expect(dice("Скриптонит", "Skrypto gramma")).toBeLessThan(0.45);
    expect(dice("Каста", "Kasta Nova")).toBeLessThan(0.7);
  });

  it("leaves pure Latin comparisons untouched", () => {
    // The skeleton folds c/k and y/i, so "Cindy" and "Kindi" would come out
    // identical if it ran here. Neither side is Cyrillic, so it does not:
    // these keep their ordinary bigram score well below a match.
    expect(dice("Cindy", "Kindi")).toBeLessThan(0.6);
    expect(dice("Nicky", "Nikki")).toBeLessThan(0.6);
  });
});
