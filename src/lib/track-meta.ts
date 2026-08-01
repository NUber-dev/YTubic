/**
 * Turning YouTube Music's display metadata into something a lyrics database
 * will recognise.
 *
 * YTM's strings are built for a UI, not for lookup: artist channels are
 * called "<Artist> - Topic", the subtitle line is a decorated breadcrumb
 * ("Video • The Weeknd • 1B views"), and titles carry upload furniture like
 * "(Official Music Video)". Every one of those was being sent to the lyrics
 * providers verbatim.
 *
 * Measured against the live LRCLIB search, each costs most or all of the
 * result set (baseline "Blinding Lights" / "The Weeknd" = 20 hits):
 *
 *   "The Weeknd - Topic"                  ->  1
 *   "Song • The Weeknd"                   ->  1
 *   "Video • The Weeknd • 1B views"       ->  0
 *   "Blinding Lights (Official Music …)"  ->  0
 *   "アイドル【MV】"                       ->  0
 *   "Die For You (feat. Ariana Grande)"   ->  5   (vs 20)
 *
 * Two things deliberately left alone, also from measurement:
 *   - Joining several artists with ", " costs nothing (20 either way), so
 *     there is no reason to reduce to a primary artist and risk dropping
 *     the one the database actually credits.
 *   - Version qualifiers like "(Remix)" cost nothing either (20 hits), so
 *     they stay in. Stripping them would erase the only thing separating a
 *     remix from its original, which matters once a real scorer lands.
 *
 * Kept dependency-free so it is unit-testable and usable from both the
 * lyrics path and the Last.fm path, which had its own copy of the "- Topic"
 * rule and none of the rest.
 */

export type TrackMetaLike = {
  title?: string;
  subtitle?: string;
  artists?: { name: string }[];
  album?: string;
};

/** YTM auto-generates a "<Artist> - Topic" channel for licensed uploads. */
export function stripTopicSuffix(s: string): string {
  return s.replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
}

/**
 * Bracket forms that CJK uploads use where latin ones use parentheses.
 * NFKC already folds the fullwidth （）［］, but leaves these alone.
 */
const CJK_OPEN = /[【〔〖「『〈《]/g;
const CJK_CLOSE = /[】〕〗」』〉》]/g;

/**
 * Bracket contents that describe the *upload* rather than the recording.
 * Matched against the whole bracket body, so "(Remix)" and "(Live at Wembley)"
 * are untouched.
 */
const NOISE_BRACKET =
  /^(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyrics?\s*video|visuali[sz]er|m\s*\/?\s*v|hd|hq|full\s*hd|4k|8k|1080p|720p|full\s*album|colou?r\s*coded(?:\s*lyrics)?|with\s+lyrics|letra|字幕|中文字幕|歌詞|歌词|歌詞付き|가사|자막|flac|wav|mp3|lossless|\d{3,4}\s*kbps|hq\s*audio|audio\s*only)$/i;

/**
 * Featuring credits. The artist field already carries these names, and
 * leaving them in the title measurably narrows the result set.
 *
 * "with" is deliberately NOT here. It reads as a credit in
 * "(with Ariana Grande)" but as part of the name in "Stay (With Me)", and
 * the measured cost of leaving it is mild (16 hits vs 20) while the cost of
 * being wrong is losing the title outright.
 */
const FEAT_BRACKET = /^(?:feat|ft|featuring|prod)\b[.\s]/i;

/** Trailing " - Official Video" style furniture, outside any bracket. */
const TRAILING_NOISE = new RegExp(
  `\\s*[-–—|]\\s*(?:${NOISE_BRACKET.source.replace(/^\^|\$$/g, "")})\\s*$`,
  "i",
);

/**
 * Strip upload furniture from a track title, keeping anything that
 * identifies *which recording* this is.
 *
 * Returns the original when cleaning would empty the string, so a track
 * genuinely named "Audio" still gets looked up.
 */
export function cleanTrackTitle(title: string): string {
  if (!title) return title;

  // NFKC folds fullwidth latin and （） to ASCII; the CJK bracket families
  // it leaves alone are mapped by hand so one scan covers every form.
  let out = title
    .normalize("NFKC")
    .replace(CJK_OPEN, "(")
    .replace(CJK_CLOSE, ")");

  out = dropMatchingBrackets(out);
  out = out.replace(TRAILING_NOISE, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  // A dangling separator left behind by a removed tail.
  out = out.replace(/[-–—|,]\s*$/, "").trim();

  return out.length > 0 ? out : title;
}

/**
 * Remove bracket groups whose body is upload noise or a featuring credit.
 * Written as a scan rather than one regex so nesting and unbalanced
 * brackets (both common in user uploads) cannot make it eat the title.
 */
function dropMatchingBrackets(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const close = ch === "(" ? ")" : ch === "[" ? "]" : ch === "{" ? "}" : null;
    if (!close) {
      out += ch;
      i++;
      continue;
    }
    const end = s.indexOf(close, i + 1);
    if (end === -1) {
      // Unbalanced: treat the bracket as ordinary text.
      out += ch;
      i++;
      continue;
    }
    const body = s.slice(i + 1, end).trim();
    if (!NOISE_BRACKET.test(body) && !FEAT_BRACKET.test(body)) {
      out += s.slice(i, end + 1);
    }
    i = end + 1;
  }
  return out;
}

/** Segments of a subtitle breadcrumb that are never an artist name. */
const TYPE_TOKEN =
  /^(?:song|video|album|single|ep|playlist|artist|podcast|episode|show)$/i;
const TIMESTAMP = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const YEAR = /^\d{4}$/;
const COUNT =
  /^[\d.,\s]+[kmbкмб]?\s*(?:views?|plays?|streams?|monthly\s+(?:listeners?|audience)|subscribers?|songs?|tracks?)$/i;

/**
 * Pull the artist out of YTM's subtitle breadcrumb.
 *
 * Shapes seen in the search fixtures: "Song • The Weeknd",
 * "Video • The Weeknd • 1B views", "Artist • 224M monthly audience".
 * Requests go out with `hl: "en"` (see innertube/shared.ts), so the type
 * and count words are reliably English.
 *
 * Returns undefined when nothing in the line is a name. That is the point:
 * an artist we cannot determine must be absent, not a decorated string that
 * every provider will fail to match.
 */
export function artistFromSubtitle(
  subtitle: string | undefined,
): string | undefined {
  if (!subtitle) return undefined;
  const parts = subtitle
    .split(/\s*[•·|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // The type word only counts as furniture in the leading position;
    // "Song" is also a legitimate band name further along.
    if (i === 0 && TYPE_TOKEN.test(p)) continue;
    if (TIMESTAMP.test(p) || YEAR.test(p) || COUNT.test(p)) continue;
    const cleaned = stripTopicSuffix(p);
    if (cleaned) return cleaned;
  }
  return undefined;
}

/** The structured artist list, joined and de-Topic'd, or undefined. */
export function artistsFromList(
  artists: { name: string }[] | undefined,
): string | undefined {
  if (!artists?.length) return undefined;
  const joined = artists
    .map((a) => stripTopicSuffix(a.name ?? ""))
    .filter(Boolean)
    .join(", ");
  return joined || undefined;
}

/**
 * Re-uploads invert the usual arrangement: the real artist is in the title
 * and the artist field holds the uploader's channel name.
 *
 * "Скриптонит - Жить как я живу (flac)" credited to "Skrypto gramma" finds
 * nothing anywhere, because no lyrics database has heard of the channel.
 * Split the other way it is an ordinary track with six records.
 *
 * Returned as an ALTERNATIVE, never as the primary reading, and only when
 * the known artist appears nowhere in the title. Guessing this eagerly
 * would wreck a genuine "A - B" title whose artist simply is not written
 * in it: "Numb - Encore" by Jay-Z would go looking for "Encore" by "Numb".
 * As a fallback the downside is bounded, since the alternative is only
 * tried once the ordinary reading has already come back empty.
 */
export function reattributedFromTitle(
  title: string,
  knownArtist: string | undefined,
): { title: string; artist: string } | null {
  const parts = (title ?? "").split(/\s+[-–—]\s+/);
  if (parts.length !== 2) return null;
  const [left, right] = parts.map((p) => p.trim());
  if (!left || !right) return null;

  if (knownArtist) {
    const known = normalizeForScore(knownArtist);
    // If the credited artist is already in the title, the ordinary reading
    // was right and there is nothing to re-attribute.
    for (const side of [left, right]) {
      const n = normalizeForScore(side);
      if (n.includes(known) || known.includes(n)) return null;
    }
  }
  return { title: cleanTrackTitle(right), artist: left };
}

/** Shared with the matcher so both sides compare strings the same way. */
function normalizeForScore(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best available artist string for a lyrics lookup, or undefined when there
 * genuinely isn't one. Structured artists win; the subtitle breadcrumb is
 * the fallback.
 */
export function lyricsArtist(
  track: TrackMetaLike | undefined,
): string | undefined {
  if (!track) return undefined;
  return artistsFromList(track.artists) ?? artistFromSubtitle(track.subtitle);
}
