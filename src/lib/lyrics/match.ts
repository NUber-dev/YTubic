import { parseLRC } from "@/lib/lyrics/parse-lrc";

/**
 * Text primitives for deciding whether a lyrics search hit is actually the
 * track we asked for. Kept dependency-free so it is unit-testable.
 *
 * Every threshold and rule here was derived from live probes of the
 * providers rather than from taste; the cases that forced each one are
 * named in the comments. The short version of what the data says:
 *
 *   - Stripping parentheticals before comparing, which this module used to
 *     do, is the single most damaging rule available. It makes
 *     "Die For You" and "Die For You (Remix)" identical, and it turns
 *     "Through the Night (밤편지)" into "through the night", which shares
 *     zero characters with the 밤편지 we were looking for and is the only
 *     record LRCLIB has for it.
 *   - Token overlap cannot rank titles. Twenty candidates scoring exactly
 *     1.000 was the normal case across six separate probes, and
 *     Set("stay stay stay") dedupes to {stay}, so "Stay" and Taylor Swift's
 *     "Stay Stay Stay" are indistinguishable.
 *   - The same token overlap is *correct* for artists, where a subset
 *     credit is the most common correct storage form.
 *
 * So: character-bigram Dice for titles, token sets for artists.
 */

/**
 * Latin letters that NFD does not decompose, so stripping combining marks
 * leaves them untouched. "Høld On" is a real, correctly timed LRCLIB row;
 * without this fold it scores 0.857 against "Hold On" and loses.
 */
const SPECIAL_LATIN: Record<string, string> = {
  ø: "o",
  Ø: "o",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ß: "ss",
  ı: "i",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ð: "d",
  þ: "th",
};

export function foldSpecialLatin(s: string): string {
  let out = "";
  for (const ch of s) out += SPECIAL_LATIN[ch] ?? ch;
  return out;
}

/** Lowercase, fold, strip accents and punctuation, collapse whitespace. */
export function normalizeForScore(s: string): string {
  return foldSpecialLatin(s.normalize("NFKC").toLowerCase())
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Character bigrams as a MULTISET, not a set. "Alone Alone" carries the
 * bigram "al" twice and "Alone" once; deduping would discard the
 * repetition that is the entire signal separating them.
 */
function bigrams(t: string): Map<string, number> {
  const m = new Map<string, number>();
  if (t.length <= 1) {
    if (t.length === 1) m.set(t, 1);
    return m;
  }
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * Sørensen-Dice over character bigrams, on normalized input.
 *
 * Chosen over token overlap and over the bigram overlap coefficient because
 * it is the only one of the three with a usable middle band. Measured:
 * "Звезда по имени Солнце" vs "Звезда" is 0.385 (different songs) while the
 * same title with different casing is 1.000; both of the others return
 * 1.000 for each. "Stay" vs "Stay Stay Stay" is 0.375 here and 1.000 there.
 */
/**
 * Cyrillic to Latin, the convention the lyrics databases use when they
 * romanize. Not a standard: matched against what is actually stored.
 */
const CYRILLIC_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
};

/**
 * The romanized spelling of a Cyrillic name, or null if there is nothing to
 * romanize.
 *
 * Providers filter by artist server-side, and they do it by containment:
 * asking LRCLIB for "Скриптонит" returns six rows, all Cyrillic-credited
 * and all unsynced, while the synced records are filed under "Skryptonite"
 * and only surface with no artist filter at all. Scoring cannot fix that,
 * because those rows never reach the scorer. The query has to ask for both
 * spellings.
 */
export function romanizedArtist(s: string | undefined): string | null {
  if (!s) return null;
  const t = transliterate(s.toLowerCase());
  return t === s.toLowerCase() ? null : t;
}

function transliterate(s: string): string {
  let out = "";
  let touched = false;
  for (const ch of s) {
    const t = CYRILLIC_LATIN[ch];
    if (t === undefined) out += ch;
    else {
      out += t;
      touched = true;
    }
  }
  return touched ? out : s;
}

/**
 * Collapse the ways two romanization schemes disagree about one name:
 * i/y, c/k, doubled letters, a decorative trailing "e".
 *
 * Aggressive, so it is only ever reached when one side was Cyrillic, and
 * only trusted on a near-exact result (see `dice`). Pure Latin comparisons
 * never see it, or "Cindy" and "Kindi" would start matching.
 */
function romanizationSkeleton(s: string): string {
  return normalizeForScore(s)
    .replace(/kh/g, "h")
    .replace(/ck/g, "k")
    .replace(/c/g, "k")
    .replace(/[yj]/g, "i")
    .replace(/(.)\1+/g, "$1")
    .replace(/e\b/g, "")
    .trim();
}

/** A skeleton match this close means one name spelled two ways. */
const SKELETON_PROMOTE = 0.85;

export function dice(a: string, b: string): number {
  const raw = diceRaw(a, b);

  // Databases store Cyrillic acts romanized about as often as not:
  // "Скриптонит" is filed as both "Skryptonite" and "Scriptonite", and it
  // is the romanized rows that carry the timings. Comparing raw scores
  // those 0, which reads as a different artist and throws the timings away.
  const ta = transliterate(a.toLowerCase());
  const tb = transliterate(b.toLowerCase());
  if (ta === a.toLowerCase() && tb === b.toLowerCase()) return raw;

  const translit = Math.max(raw, diceRaw(ta, tb));

  // Transliteration alone leaves "Скриптонит" against "Skryptonite" at
  // 0.737, which is not a doubt about who the artist is: it is the i/y and
  // trailing-e noise between two romanization conventions. Scoring it as
  // doubt costs the synced lyrics, since the plain rows spell the name
  // exactly and win at 1.000.
  //
  // Promoting only on a near-exact skeleton is what keeps this honest.
  // "Каста" against "Kasta Nova" skeletons to 0.615 and "Скриптонит"
  // against the uploader "Skrypto gramma" to 0.571; both stay on their
  // lower transliterated score. Genuine spelling variants land at 1.000.
  const skeleton = diceRaw(
    romanizationSkeleton(ta),
    romanizationSkeleton(tb),
  );
  return skeleton >= SKELETON_PROMOTE ? Math.max(translit, skeleton) : translit;
}

function diceRaw(a: string, b: string): number {
  const A = bigrams(normalizeForScore(a));
  const B = bigrams(normalizeForScore(b));
  const sizeA = [...A.values()].reduce((x, y) => x + y, 0);
  const sizeB = [...B.values()].reduce((x, y) => x + y, 0);
  if (sizeA === 0 || sizeB === 0) return 0;
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  return (2 * shared) / (sizeA + sizeB);
}

/**
 * Providers store one recording's title joined to itself with a unit
 * separator or a semicolon ("Hurt<US>Hurt", "One Kiss;One Kiss").
 *
 * Only those two delimiters, and only with no surrounding whitespace:
 * collapsing repeated words in general would merge "Stay Stay Stay",
 * "Go Go Go Go" and "ALONE ALONE ALONE" into the titles they must stay
 * distinct from.
 */
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

export function collapseSelfJoin(s: string): string {
  // U+001F (unit separator) and ";" only, written as escapes because a
  // literal control character is invisible in an editor.
  for (const sep of [UNIT_SEPARATOR, ";"]) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep).map((p) => p.trim());
    if (parts.length > 1 && parts.every((p) => p === parts[0]) && parts[0]) {
      return parts[0];
    }
  }
  return s;
}

export type QualifierClass = "hard" | "soft";
export type Qualifier = { text: string; cls: QualifierClass };
export type ParsedTitle = {
  /** The title with furniture and qualifiers removed. */
  base: string;
  qualifiers: Qualifier[];
  /** Bracketed titles in a different script: a translation, not a variant. */
  alts: string[];
};

/**
 * Qualifiers that identify a DIFFERENT recording with possibly different
 * words. A mismatch here is strong evidence.
 */
const HARD_QUALIFIER =
  /\b(remix|live|acoustic|unplugged|sped\s*up|slowed|reverb|nightcore|demo|instrumental|karaoke|cover|radio\s*edit|extended|club\s*mix|8d|432\s*hz|tiktok)\b/i;

/**
 * Qualifiers that label the same recording. Ignored for identity entirely.
 *
 * "Remastered" is the load-bearing member: every correct
 * "Hotel California (2013 Remaster)" row is 391s, identical to the
 * unqualified studio rows, and a plain search returns zero remaster-tagged
 * titles. Penalizing it rejects the whole correct set.
 */
const SOFT_QUALIFIER =
  /\b(remaster(ed)?|explicit|clean|single\s*version|album\s*version|original\s*mix|stereo|mono|deluxe|anniversary|bonus\s*track|edition|official|mv|video|audio|\d{4})\b/i;

function classify(body: string): QualifierClass | null {
  if (HARD_QUALIFIER.test(body)) return "hard";
  if (SOFT_QUALIFIER.test(body)) return "soft";
  return null;
}

type Script = "latin" | "cyrillic" | "han" | "kana" | "hangul" | "other";

function scriptsOf(s: string): Set<Script> {
  const out = new Set<Script>();
  for (const ch of s) {
    if (/\p{Script=Latin}/u.test(ch)) out.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) out.add("cyrillic");
    else if (/\p{Script=Han}/u.test(ch)) out.add("han");
    else if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(ch))
      out.add("kana");
    else if (/\p{Script=Hangul}/u.test(ch)) out.add("hangul");
  }
  if (out.size === 0) out.add("other");
  return out;
}

function disjointScripts(a: string, b: string): boolean {
  const A = scriptsOf(a);
  for (const s of scriptsOf(b)) if (A.has(s)) return false;
  return true;
}

/**
 * Split a raw title into the part that identifies the song, the qualifiers
 * that identify which recording, and any cross-script alternative title.
 *
 * `artistHint` lets the artist's own name be stripped when a provider has
 * baked it into the title ("Marshmello - Alone", "Levels - Avicii - Levels").
 */
export function parseTitle(raw: string, artistHint?: string): ParsedTitle {
  let s = collapseSelfJoin(raw ?? "").normalize("NFKC");

  // Upload-id suffixes: "Alone (Original Mix)_264023874".
  s = s.replace(/_\d{6,}/g, " ");

  s = stripArtistAffix(s, artistHint);

  const qualifiers: Qualifier[] = [];
  const alts: string[] = [];
  let base = "";

  // Left-to-right bracket scan. An unbalanced opener means everything after
  // it is the body: that is what rescues the real row
  // "Sticky (feat. GloRilla, Sexyy Red".
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const close = ch === "(" ? ")" : ch === "[" ? "]" : ch === "{" ? "}" : null;
    if (!close) {
      base += ch;
      i++;
      continue;
    }
    const end = s.indexOf(close, i + 1);
    const body = (end === -1 ? s.slice(i + 1) : s.slice(i + 1, end)).trim();
    const cls = classify(body);
    if (cls) qualifiers.push({ text: body, cls });
    else if (body) alts.push(body);
    i = end === -1 ? s.length : end + 1;
  }

  base = base.replace(/\s+/g, " ").trim();

  // Dash and wide-whitespace qualifier forms: "Hotel California - 2013
  // Remaster", "Everlong     Acoustic".
  for (const re of [/^(.*?)\s+[-–—]\s+(.+)$/, /^(.*?)\s{3,}(\S.*)$/]) {
    const m = base.match(re);
    if (!m) continue;
    const cls = classify(m[2]);
    if (cls) {
      qualifiers.push({ text: m[2].trim(), cls });
      base = m[1].trim();
    }
  }

  // An alt only counts when it is in a different script from the base: a
  // translation or transliteration rather than a variant. Ungated, this is
  // dangerous - it lifts the stranger "Hurt Niggas (Hurt)" to a perfect
  // score against "Hurt", and erases the remix distinction entirely.
  const keptAlts = alts.filter(
    (a) =>
      normalizeForScore(a) !== normalizeForScore(base) &&
      disjointScripts(a, base),
  );

  return { base: base || raw?.trim() || "", qualifiers, alts: keptAlts };
}

function stripArtistAffix(title: string, artist?: string): string {
  if (!artist) return title;
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length < 2) return title;
  const na = normalizeForScore(artist);
  // "Levels - Avicii - Levels": first and last agree, the middle is noise.
  if (
    parts.length >= 3 &&
    normalizeForScore(parts[0]) === normalizeForScore(parts[parts.length - 1])
  ) {
    return parts[0];
  }
  const kept = parts.filter((p) => normalizeForScore(p) !== na);
  return kept.length > 0 ? kept.join(" - ") : title;
}

/**
 * How strongly two parsed titles name the same song, ignoring which
 * recording. 0 means no shared characters at all, which for cross-script
 * pairs ("Группа крови" / "Gruppa Krovi") is uninformative rather than
 * negative; callers handle that case separately.
 */
export function titleIdentity(q: ParsedTitle, c: ParsedTitle): number {
  let best = dice(q.base, c.base);
  for (const alt of [...q.alts, ...c.alts]) {
    best = Math.max(best, dice(q.base, alt), dice(c.base, alt));
  }
  return best;
}

/**
 * Compare only the HARD qualifier sets; SOFT ones are ignored outright.
 * Returns a multiplier, never a veto: correct rows are very often bare
 * (every Metallica live take and all three live "Levitating" rows have
 * completely unqualified titles).
 */
export function qualifierFactor(q: ParsedTitle, c: ParsedTitle): number {
  const hard = (p: ParsedTitle) =>
    new Set(
      p.qualifiers
        .filter((x) => x.cls === "hard")
        .map((x) => normalizeForScore(x.text)),
    );
  const Q = hard(q);
  const C = hard(c);
  if (Q.size === 0 && C.size === 0) return 1;
  const shared = [...Q].filter((x) => C.has(x));
  if (shared.length > 0 && Q.size === C.size) return 1;
  // Asymmetric on purpose: an explicit wrong-version tag is stronger
  // evidence than a missing one, because bare titles are so often correct.
  if (Q.size > 0 && C.size === 0) return 0.75;
  if (C.size > 0 && Q.size === 0) return 0.55;
  return shared.length > 0 ? 0.75 : 0.35;
}

/**
 * Artist names, as a token set.
 *
 * Deliberately NOT split into names. Every plausible separator lives inside
 * some real artist's name: the comma in "Tyler, The Creator" and
 * "Earth, Wind & Fire", the ampersand in "Dimitri Vegas & Like Mike", the
 * hyphen in "D-Block Europe", the plus in "Florence + The Machine". Worse,
 * the databases already contain the results of somebody else having split
 * them: twenty LRCLIB rows are credited to "Earth, Wind", and the only
 * correct EARFQUAKE record is credited to "The Creator".
 *
 * Tokenizing sidesteps all of it.
 */
/**
 * Delimiters providers put between credits. Written as escapes because
 * three of them are invisible control characters. One recording in the
 * corpus appeared under seven different encodings of one credit.
 */
const CREDIT_SEPARATORS = new RegExp(
  `[${[0x0000, 0x001f, 0xfeff, 0xfffe, 0x3001, 0xff0c, 0x30fb]
    .map((c) => String.fromCharCode(c))
    .join("")}]`,
  "g",
);

export function artistTokens(s: string): Set<string> {
  const cleaned = normalizeForScore(
    (s ?? "")
      .replace(/\\,/g, ",")
      // Separators the providers actually emit between credits, written as
      // escapes because the control characters are invisible in an editor.
      .replace(CREDIT_SEPARATORS, " "),
  );
  const drop = new Set([
    "feat",
    "ft",
    "featuring",
    "with",
    "vs",
    "versus",
    "prod",
    "presents",
    "and",
  ]);
  return new Set(cleaned.split(" ").filter((t) => t && !drop.has(t)));
}

/** Ratio of shared tokens over the smaller set. Correct for artists, where
 *  a subset credit is the most common correct form, and wrong for titles. */
export function tokenOverlap(a: string, b: string): number {
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

function isTruncatedCredit(
  reqNames: string[],
  hitNames: string[],
  hitTokens: Set<string>,
): boolean {
  for (const n of hitNames) {
    const nn = normalizeForScore(n);
    if (!nn) continue;
    for (const r of reqNames) {
      const rr = normalizeForScore(r);
      // A hit name equal to a whole request name is a subset credit, not a
      // truncation.
      if (rr === nn || !rr.startsWith(nn + " ")) continue;
      const covered = [...artistTokens(r)].every((t) => hitTokens.has(t));
      if (!covered) return true;
    }
  }
  return false;
}

/** Best-effort name split, used ONLY for penalties, never for identity. */
function pseudoNames(s: string): string[] {
  return (s ?? "")
    .split(/[,;/\\|&]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * How well two artist credits agree, in [0, 1].
 *
 * Subset in either direction is free, because the databases store the
 * surviving credit as the first, the last, or a middle name with no
 * pattern: "Rich Flex" is stored under Drake alone, "Wild Thoughts" under
 * Rihanna alone (the featured artist, with the billed lead absent), and
 * "Tremor" under the last-listed Martin Garrix.
 */
export function artistScore(
  req: string,
  hit: string,
  durationDelta?: number,
): number {
  const R = artistTokens(req);
  const H = artistTokens(hit);
  if (R.size === 0 || H.size === 0) return 0;
  let shared = 0;
  for (const t of R) if (H.has(t)) shared++;
  const coverage = Math.max(shared / R.size, shared / H.size);
  // Rescues script variants that share no tokens: 周杰伦 / 周杰倫.
  let s = Math.max(coverage, dice(req, hit));

  const rn = pseudoNames(req);
  const hn = pseudoNames(hit);

  // A credited name with nothing in common with the request: the candidate
  // is a collaboration we did not ask for.
  let extra = 0;
  for (const n of hn) {
    const toks = artistTokens(n);
    const anyShared = [...toks].some((t) => R.has(t));
    if (!anyShared && rn.every((r) => dice(n, r) < 0.5)) extra++;
  }
  s -= 0.35 * Math.min(extra, 2);

  // A truncated credit: "Linkin" for "Linkin Park", which LRCLIB returns at
  // rank 0 for a Linkin Park query and is a genuinely different artist. It
  // cannot be rejected on the available evidence, only outranked.
  //
  // The guard is that the request name it truncates is not itself fully
  // covered by the hit. Without that, "Drake" for "Drake, 21 Savage" would
  // be penalized too, and a subset credit is the most common correct form.
  if (isTruncatedCredit(rn, hn, H)) s -= 0.15;

  // One name where we asked for several, and the duration disagrees too.
  if (H.size === 1 && R.size > 1) {
    if (durationDelta === undefined || Math.abs(durationDelta) > 5) s -= 0.4;
  }

  return Math.max(0, Math.min(1, s));
}

/**
 * Duration agreement as a smooth curve rather than a window.
 *
 * No hard window works: the same recording spreads over 386-395s for Hotel
 * California, while genuinely different versions sit 4s apart. Anchored on
 * the measured same-recording spread (14 of 20 "bad guy" rows within 2s)
 * and on real version gaps (electric 251 vs acoustic 281).
 */
export function durationScore(delta: number | null | undefined): number {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) {
    return 0.3;
  }
  const d = Math.abs(delta) / 12;
  return 1 / (1 + d * d);
}

/**
 * When the last timed line falls, in seconds. Used to catch an LRC whose
 * body belongs to a longer edit than the audio: 20% of probed synced
 * records overrun their own stored duration, and a highlight running 68s
 * past the end is a visible bug that no duration field reveals.
 */
export function lastTimestamp(lrc: string | null | undefined): number | null {
  if (!lrc || !lrc.trim()) return null;
  const lines = parseLRC(lrc);
  if (lines.length === 0) return null;
  return lines[lines.length - 1].start;
}
