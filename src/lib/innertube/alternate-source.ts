import { fetchSearch } from "./search";
import { fetchArtist } from "./artist";
import { fetchCounterpartVideoId } from "./counterpart";
import type { SourceKind } from "@/lib/store/track-source";
import type { ShelfItem } from "./types";
import { diagLog } from "@/lib/diagnostics";
import { getVideoBriefs, getVideoMeta } from "./video-meta";

/**
 * Find the alternate-source videoId for a track. Given a song's videoId
 * (and the title / artist line we've got in metadata), search YT Music
 * with the opposite kind filter and pick the first result that isn't
 * the input id and is actually credited to (or at least names) one of
 * the expected artists.
 *
 * Used to play the uncensored / original audio when YT Music's "song"
 * version is the censored one (common for Russian artists working
 * around the local lyric ban — switching to the music-video source
 * gets you the real recording).
 */

function normalizeArtist(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const ARTIST_SPLIT = /\s*(?:,|&|、|\/|\bfeat\.?\b|\bft\.?\b)\s*/i;

/**
 * A collaboration arrives as one string ("VALORANT & KiNG MALA"), so every
 * artist check ends up matching against a blob: a channel called "Mala"
 * passes because "valorantkingmala" contains "mala". Splitting adds the
 * individual names WITHOUT dropping the original, so anything that matched
 * before still matches and per-name checks get something real to compare.
 */
function expandArtistNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const whole = name.trim();
    if (whole) out.add(whole);
    for (const part of name.split(ARTIST_SPLIT)) {
      const piece = part.trim();
      if (piece.length > 1) out.add(piece);
    }
  }
  return [...out];
}

function matchesArtist(item: ShelfItem, expected: string[]): boolean {
  if (expected.length === 0) return true;
  const itemArtists = (item.artists ?? [])
    .map((a) => normalizeArtist(a.name))
    .filter(Boolean);
  const normTitle = normalizeArtist(item.title);
  return expected.some((name) => {
    const norm = normalizeArtist(name);
    if (!norm) return false;
    if (itemArtists.some((a) => a.includes(norm) || norm.includes(a))) return true;
    return norm.length > 2 && normTitle.includes(norm);
  });
}

function hasUnexpectedArtist(item: ShelfItem, expected: string[]): boolean {
  if (expected.length === 0) return false;
  const itemArtists = (item.artists ?? [])
    .map((a) => normalizeArtist(a.name))
    .filter(Boolean);
  if (itemArtists.length === 0) return false;
  const normExpected = expected.map(normalizeArtist).filter(Boolean);
  return itemArtists.some(
    (a) => !normExpected.some((e) => a.includes(e) || e.includes(a)),
  );
}

const OFFICIAL_HINT = /\bofficial\b/i;
const NON_OFFICIAL_HINTS = [
  /\bcover\b/i,
  /karaoke/i,
  /reaction/i,
  /\blive\b/i,
  /instrumental/i,
  /sped up/i,
  /slowed/i,
  /nightcore/i,
  /\bloop(ed)?\b/i,
  /\bextended\b/i,
  /\bedit\b/i,
  /mashup/i,
  /\bamv\b/i,
  /best part/i,
  /play\s*along/i,
  /isolated/i,
  /a\s*cap+ella/i,
  /\bremix\b/i,
  /vocals?\s*only/i,
  /no\s+(guitar|vocals?|drums?|bass)\b/i,
  /backing\s*track/i,
  /full\s*album/i,
  /\d+d\s*audio/i,
  /bass\s*boost(ed)?/i,
  /\breverb\b/i,
  /tutorial/i,
  /\blesson\b/i,
  /how\s*to\s*play/i,
  /\b(bass|guitar|drum)\s*tabs?\b/i,
  /notation/i,
  /faded\s*ending/i,
  /\balbum\s*version\b/i,
  /\bradio\s*edit\b/i,
];

const SOFT_HINTS = [
  /\blyrics?\b/i,
  /visuali[sz]er/i,
  /\blirik\b/i,
  /terjemahan/i,
  /traduç[aã]o/i,
  /traducci[oó]n/i,
  /legendado/i,
  /subtitulado/i,
  /\bsub\.?\s*espa[ñn]ol\b/i,
  /가사/,
  /해석/,
  /歌詞|歌词/,
];

function tierOf(title: string): number {
  if (OFFICIAL_HINT.test(title)) return 0;
  if (NON_OFFICIAL_HINTS.some((hint) => hint.test(title))) return 2;
  return 1;
}

function hasStructuredArtistMatch(item: ShelfItem, expected: string[]): boolean {
  if (expected.length === 0) return false;
  const itemArtists = (item.artists ?? [])
    .map((a) => normalizeArtist(a.name))
    .filter(Boolean);
  const normExpected = expected.map(normalizeArtist).filter(Boolean);
  return itemArtists.some((a) =>
    normExpected.some((e) => a.includes(e) || e.includes(a)),
  );
}

function coreTitle(title: string): string {
  return title.replace(/[([][^)\]]*[)\]]/g, " ");
}

function titleTokens(title: string): string[] {
  return coreTitle(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function titleCoverage(
  item: ShelfItem,
  trackTitle: string,
): { coverage: number; extra: number } {
  const trackTok = titleTokens(trackTitle);
  if (trackTok.length === 0) return { coverage: 1, extra: 0 };
  const itemTok = titleTokens(item.title);
  const overlap = trackTok.filter((t) => itemTok.includes(t)).length;
  return {
    coverage: overlap / trackTok.length,
    extra: itemTok.length - trackTok.length,
  };
}

const MIN_TITLE_COVERAGE = 0.6;
const MAX_EXTRA_TITLE_TOKENS = 20;
const BRIEF_LIMIT = 24;
const VERIFY_BATCH = 10;
const VERIFY_MAX = 12;
const WORST_ACCEPTABLE_TIER = 1;
const DURATION_MIN_RATIO = 0.5;
const DURATION_MAX_RATIO = 2.5;

const VIDEO_HINT = /\b(music\s*video|official\s*video|\bmv\b)/i;
const AUDIO_HINT = /\baudio\b/i;

/**
 * 0 when the title says outright that this is the form being asked for.
 * Deliberately binary: the losing side used to be graded "audio" vs
 * "neither", which only works in English, so a Turkish "Resmi Müzik"
 * outranked the main channel's "Official Audio" for being unreadable.
 * Everything that isn't a declared match ties here and is settled by
 * popularity instead, which no language can hide from.
 */
function formatRank(title: string, targetKind: SourceKind): number {
  const looksVideo = VIDEO_HINT.test(title);
  const looksAudio = AUDIO_HINT.test(title);
  if (targetKind === "video") return looksVideo ? 0 : 1;
  return looksAudio && !looksVideo ? 0 : 1;
}

function channelMatchesArtist(channel: string | null, expected: string[]): boolean {
  if (!channel || expected.length === 0) return false;
  const norm = normalizeArtist(channel);
  return expected.some((name) => {
    const e = normalizeArtist(name);
    return e.length > 2 && (norm.includes(e) || e.includes(norm));
  });
}

function isMusicCategory(categories: string[]): boolean {
  return categories.some((c) => c.toLowerCase() === "music");
}

export async function findAlternateVideoId(
  query: string,
  currentVideoId: string,
  targetKind: SourceKind,
  expectedArtists: string[] = [],
  trackTitle: string = "",
  artistIds: string[] = [],
  trackDuration: number = 0,
): Promise<string | null> {
  if (!query.trim()) return null;

  const counterpart = await fetchCounterpartVideoId(currentVideoId);
  if (counterpart) {
    diagLog(
      "alt-video",
      `counterpart: YT Music pairs ${currentVideoId} with ${counterpart} for its own song/video switch, taking it`,
    );
    return counterpart;
  }

  expectedArtists = expandArtistNames(expectedArtists);
  const filter = targetKind === "video" ? "videos" : "songs";
  const [results, artistPages] = await Promise.all([
    fetchSearch(query, filter),
    Promise.all(artistIds.map((id) => fetchArtist(id).catch(() => null))),
  ]);
  const artistChannelIds = new Set(
    artistPages
      .map((a) => a?.channelId)
      .filter((id): id is string => Boolean(id)),
  );
  const raw: ShelfItem[] = [];
  const candidates: ShelfItem[] = [];
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (item.kind !== "song" && item.kind !== "video") continue;
      if (item.id === currentVideoId) continue;
      raw.push(item);
      if (!matchesArtist(item, expectedArtists)) continue;
      if (hasUnexpectedArtist(item, expectedArtists)) continue;
      if (trackTitle) {
        const { coverage, extra } = titleCoverage(item, trackTitle);
        if (coverage < MIN_TITLE_COVERAGE || extra > MAX_EXTRA_TITLE_TOKENS) continue;
      }
      candidates.push(item);
    }
  }
  diagLog(
    "alt-video",
    `query="${query}" expected=[${expectedArtists.join(", ")}] trackTitle="${trackTitle}" raw(${raw.length})=${raw
      .slice(0, 20)
      .map(
        (c) =>
          `"${c.title}" by [${(c.artists ?? []).map((a) => a.name).join(", ")}]`,
      )
      .join(" | ")} candidates=${candidates.length}`,
  );
  if (candidates.length === 0) return null;

  const briefPool = candidates.slice(0, BRIEF_LIMIT);
  const briefs = await getVideoBriefs(briefPool.map((c) => c.id));
  const realTitleOf = (item: ShelfItem) => briefs.get(item.id)?.title ?? item.title;
  const realChannelOf = (item: ShelfItem) => briefs.get(item.id)?.channel ?? null;

  const screened: ShelfItem[] = [];
  for (const item of briefPool) {
    const realTitle = realTitleOf(item);
    if (tierOf(realTitle) === 2) {
      diagLog(
        "alt-video",
        `dropped "${item.title}" (${item.id}) - real title "${realTitle}" is a cover/karaoke/remix/etc.`,
      );
      continue;
    }
    screened.push(item);
  }
  diagLog(
    "alt-video",
    `oembed resolved ${briefs.size}/${briefPool.length} real titles, ${screened.length} still standing`,
  );
  if (screened.length === 0) return null;

  const shortlistKey = (item: ShelfItem) => {
    const realTitle = realTitleOf(item);
    return [
      formatRank(realTitle, targetKind),
      SOFT_HINTS.some((h) => h.test(realTitle)) ? 1 : 0,
      channelMatchesArtist(realChannelOf(item), expectedArtists) ? 0 : 1,
      hasStructuredArtistMatch(item, expectedArtists) ? 0 : 1,
    ];
  };
  const shortlist = [...screened].sort((a, b) => {
    const ka = shortlistKey(a);
    const kb = shortlistKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  const hydratedIds = new Set<string>();
  const rejected = new Set<string>();
  const confirmedArtistChannel = new Set<string>();
  const verifiedChannel = new Set<string>();
  const nameMatchOnly = new Set<string>();
  const softTagIds = new Set<string>();
  const realTier = new Map<string, number>();
  const viewsById = new Map<string, number>();

  const hydrateBatch = async (items: ShelfItem[]) => {
    const hydrated = await Promise.all(
      items.map(async (item) => ({ item, meta: await getVideoMeta(item.id) })),
    );
    for (const { item, meta } of hydrated) {
      hydratedIds.add(item.id);
      if (!meta) continue;
      if (meta.title) realTier.set(item.id, tierOf(meta.title));
      if (meta.viewCount) viewsById.set(item.id, meta.viewCount);
      const onArtistChannel = !!meta.channelId && artistChannelIds.has(meta.channelId);
      const nameMatch = channelMatchesArtist(meta.channel, expectedArtists);
      const music = isMusicCategory(meta.categories);
      const realTitle = meta.title ?? realTitleOf(item);
      const badTag = tierOf(realTitle) === 2;
      const softTag = SOFT_HINTS.some((h) => h.test(realTitle));
      const trustedChannel = onArtistChannel || !!meta.channelIsVerified;
      const offDuration =
        !!trackDuration &&
        !!meta.duration &&
        (meta.duration < trackDuration * DURATION_MIN_RATIO ||
          meta.duration > trackDuration * DURATION_MAX_RATIO);
      if (softTag) softTagIds.add(item.id);
      if (offDuration) {
        rejected.add(item.id);
        diagLog(
          "alt-video",
          `rejected "${item.title}" (${item.id}) - runs ${Math.round(meta.duration ?? 0)}s against a ${Math.round(trackDuration)}s track`,
        );
      } else if (badTag) {
        rejected.add(item.id);
        diagLog(
          "alt-video",
          `rejected "${item.title}" (${item.id}) - real title "${meta.title}" carries a lyrics/cover/karaoke/etc. tag the search result hid`,
        );
      } else if (softTag && !trustedChannel) {
        rejected.add(item.id);
        diagLog(
          "alt-video",
          `rejected "${item.title}" (${item.id}) - real title "${meta.title}" is a lyrics/visualizer video from an unverified channel`,
        );
      } else if (onArtistChannel) {
        confirmedArtistChannel.add(item.id);
        diagLog(
          "alt-video",
          `confirmed "${item.title}" (${item.id}) - posted on the artist's own channel`,
        );
      } else if (meta.channelIsVerified) {
        verifiedChannel.add(item.id);
        diagLog(
          "alt-video",
          `trusted "${item.title}" (${item.id}) - verified channel "${meta.channel ?? "unknown"}"${nameMatch ? " names an expected artist" : " hosting content outside the artist's own channel"}`,
        );
      } else if (nameMatch) {
        nameMatchOnly.add(item.id);
        diagLog(
          "alt-video",
          `matched "${item.title}" (${item.id}) - real channel "${meta.channel ?? "unknown"}" names an expected artist`,
        );
      } else if (!music) {
        rejected.add(item.id);
        diagLog(
          "alt-video",
          `rejected "${item.title}" (${item.id}) - real channel "${meta.channel ?? "unknown"}" categories=[${meta.categories.join(", ")}] doesn't match ${expectedArtists.join("/")}`,
        );
      } else if (formatRank(realTitle, targetKind) === 0) {
        diagLog(
          "alt-video",
          `unverified "${item.title}" (${item.id}) - real channel "${meta.channel ?? "unknown"}" isn't verified, but the upload presents itself as the official one; keeping as a last resort`,
        );
      } else {
        rejected.add(item.id);
        diagLog(
          "alt-video",
          `rejected "${item.title}" (${item.id}) - real channel "${meta.channel ?? "unknown"}" is an unverified reupload that doesn't name ${expectedArtists.join("/")}`,
        );
      }
    }
  };

  let verifiedCount = 0;
  while (verifiedCount < shortlist.length && verifiedCount < VERIFY_MAX) {
    const batch = shortlist.slice(verifiedCount, verifiedCount + VERIFY_BATCH);
    await hydrateBatch(batch);
    verifiedCount += batch.length;
    if (batch.some((c) => !rejected.has(c.id))) break;
    diagLog(
      "alt-video",
      `all ${verifiedCount} verified so far were rejected, reaching further down the shortlist`,
    );
  }

  const survivors = shortlist.filter(
    (c) => hydratedIds.has(c.id) && !rejected.has(c.id),
  );
  if (survivors.length === 0) {
    diagLog("alt-video", "every verified candidate failed, aborting");
    return null;
  }
  const effectiveTier = (c: ShelfItem) => realTier.get(c.id) ?? tierOf(realTitleOf(c));
  const bestSurvivorTier = Math.min(...survivors.map(effectiveTier));
  if (bestSurvivorTier > WORST_ACCEPTABLE_TIER) {
    diagLog(
      "alt-video",
      `best surviving candidate is only tier ${bestSurvivorTier} (lyrics/slowed/loop/etc.) after verification, aborting rather than settling`,
    );
    return null;
  }
  const priorityOf = (c: ShelfItem) => {
    const soft = softTagIds.has(c.id) ? 1 : 0;
    if (confirmedArtistChannel.has(c.id)) return soft;
    if (verifiedChannel.has(c.id)) return 2 + soft;
    if (nameMatchOnly.has(c.id)) return 4;
    return 5;
  };
  const unidentifiedArtist = expectedArtists.length === 0;
  if (unidentifiedArtist) {
    diagLog(
      "alt-video",
      "no expected artist on this track, so a verified channel proves nothing about identity; ranking on reach instead",
    );
  }
  const finalKey = (c: ShelfItem) =>
    unidentifiedArtist
      ? [formatRank(realTitleOf(c), targetKind), -(viewsById.get(c.id) ?? 0)]
      : [
          priorityOf(c),
          formatRank(realTitleOf(c), targetKind),
          -(viewsById.get(c.id) ?? 0),
        ];
  survivors.sort((a, b) => {
    const ka = finalKey(a);
    const kb = finalKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  const best = survivors[0];
  diagLog(
    "alt-video",
    `picked "${realTitleOf(best)}" (${best.id}) after verifying ${verifiedCount} of ${shortlist.length}`,
  );
  return best.id;
}
