export type Thumbnail = {
  url: string;
  width?: number;
  height?: number;
};

export type MinimalArtist = {
  id?: string;
  name: string;
};

export type ShelfItemKind =
  "song" | "video" | "album" | "playlist" | "artist" | "category";

export type ShelfItem = {
  kind: ShelfItemKind;
  id: string;
  title: string;
  subtitle?: string;
  thumbnails: Thumbnail[];
  /** For songs/videos: artist list */
  artists?: MinimalArtist[];
  /** For songs/videos: album name */
  album?: string;
  /** Browse id for the album, when the row links to one (e.g. "MPREb_…") */
  albumId?: string;
  /** For songs/videos: duration in seconds */
  duration?: number;
  /**
   * videoId of this row's song<->video counterpart, when YT Music paired
   * them in a /next `playlistPanelVideoWrapperRenderer`. Always the
   * opposite `kind` (an audio-track version for a music video, or the
   * music video for a song), so the Source toggle can switch to the real
   * other version instead of a fuzzy search.
   */
  counterpartId?: string;
  /** Explicit-content badge present on the row */
  explicit?: boolean;
  /** Pre-formatted play count text from YT Music ("1.2M plays"). Album rows. */
  playCount?: string;
  /** Pre-formatted "added to playlist" date. User-owned editable playlists. */
  dateAdded?: string;
  /** Round (true for artists) */
  round?: boolean;
  /**
   * For "playlist" cards that are actually long-form videos with timestamp
   * chapters (YT Music auto-generates a /playlist/$id page that we can't
   * parse). When set, clicking the card plays this video instead of
   * navigating into the broken playlist page.
   */
  playableVideoId?: string;
  /**
   * For "category" tiles (Moods & Genres). Opaque InnerTube continuation
   * params required to load the category's contents — pair with `id`
   * (browseId) on the next browse call.
   */
  categoryParams?: string;
  /**
   * For "category" tiles. Solid background as a CSS color string
   * (`#rrggbb`), parsed from `solid.leftStripeColor` (signed ARGB int).
   */
  tint?: string;
};

export type Shelf = {
  id: string;
  title: string;
  subtitle?: string;
  items: ShelfItem[];
  /**
   * Hint for the UI: "list" when the shelf came from a row renderer
   * (musicResponsiveListItemRenderer — typical Top Songs section on
   * artist pages), "card" for the usual horizontal carousel of cards,
   * "grid" for sheets of `musicNavigationButtonRenderer` tiles (Moods
   * & Genres). Defaults to "card" when the parser can't tell.
   */
  display?: "list" | "card" | "grid";
};

export type ArtistPage = {
  id: string;
  name: string;
  description?: string;
  subscribers?: string;
  thumbnails: Thumbnail[];
  /** Radio / shuffle endpoint video id, if present */
  radioId?: string;
  shuffleId?: string;
  shelves: Shelf[];
};

export type AlbumPage = {
  id: string;
  title: string;
  artists: MinimalArtist[];
  year?: string;
  trackCount?: number;
  duration?: string;
  thumbnails: Thumbnail[];
  tracks: ShelfItem[];
};

export type PlaylistPage = {
  id: string;
  title: string;
  description?: string;
  owner?: string;
  trackCount?: number;
  thumbnails: Thumbnail[];
  tracks: ShelfItem[];
};

/**
 * The primary action YTM attaches to the top-result card — a "Shuffle"
 * (artist) or "Play" (song / album / playlist) button. Either a direct
 * `videoId` (play it) or a `playlistId` to expand into a queue via /next.
 */
export type TopResultAction = {
  label: string;
  kind: "shuffle" | "play";
  videoId?: string;
  playlistId?: string;
};

export type SearchResults = {
  query: string;
  /**
   * The "Top result" hero (only on the "all" tab) — the single best-matching
   * entity (artist / album / song / video / playlist) YTM promotes above the
   * grouped result sections.
   */
  topResult?: ShelfItem;
  /** The top-result card's Shuffle / Play button, when present. */
  topResultAction?: TopResultAction;
  shelves: Shelf[];
};
