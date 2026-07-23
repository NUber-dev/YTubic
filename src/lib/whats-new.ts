export type WhatsNewChangeType = "new" | "improved" | "fixed" | "security";

export type WhatsNewChange = {
  type: WhatsNewChangeType;
  /** Short bolded lead-in, e.g. "Discord Rich Presence". */
  title: string;
  /** One or two sentences of detail rendered after the title. */
  text: string;
};

export type WhatsNewEntry = {
  /** Semver string, e.g. "0.2.0", matched against the running app version. */
  version: string;
  /** Display date, pre-formatted so there's no locale work at runtime. */
  date: string;
  /**
   * One-line summary shown as the entry's title on the timeline, both
   * collapsed and expanded. No trailing period.
   */
  summary: string;
  /**
   * Bundled hero image served from `/public`, e.g.
   * "/whats-new/0.2.0.jpg". Entries without one render no preview box
   * at all.
   */
  image?: string;
  /**
   * Which edge of the image survives the object-cover crop. Defaults
   * to center; use "top" when the subject sits at the top of the shot.
   */
  imageAlign?: "top";
  /**
   * Typed change list. The dialog groups these into "New & Improved",
   * "Fixed", and "Security" sections with counts, in that order.
   */
  changes: WhatsNewChange[];
  /**
   * Prose message rendered as a soft note panel below the changes. Use
   * for a personal note from the developer rather than a change list.
   */
  note?: string;
  /**
   * Short call-to-action rendered as a yellow alert panel at the
   * bottom. Use for a must-read instruction, e.g. signing in again
   * after an update.
   */
  alert?: string;
};

/**
 * Curated release notes for the What's New dialog, newest first. The
 * dialog renders the whole list as a timeline with the relevant entry
 * expanded. Add an entry here for every user-facing release; keep the
 * copy free of em/en dashes.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: "0.4.0",
    date: "July 23, 2026",
    summary: "YTubic comes to Linux and macOS",
    image: "/whats-new/0.4.0.jpg",
    imageAlign: "top",
    changes: [
      {
        type: "new",
        title: "Linux and macOS support",
        text: "YTubic now runs on Linux and macOS, in beta while the rough edges get filed down. Grab the build for your platform from the releases page.",
      },
      {
        type: "improved",
        title: "Artist pages",
        text: "Redesigned from the ground up: a Subscribe button, reworked scrolling and header behavior across the app, and full track, album, and release lists behind every More link.",
      },
      {
        type: "improved",
        title: "Resizable layout",
        text: "Drag to resize the sidebar and the player panel.",
      },
      {
        type: "fixed",
        title: "Playlist suggestions",
        text: "Suggested tracks are no longer mixed into your playlists. They live in their own Suggestions section at the end, with a Refresh button for a fresh batch.",
      },
      {
        type: "fixed",
        title: "True shuffle",
        text: "Shuffling a playlist now uses YouTube Music's server-side shuffle across every track, not just the ones that had loaded.",
      },
      {
        type: "fixed",
        title: "Remove from playlist",
        text: "Take tracks out of your own playlists straight from the track menu.",
      },
      {
        type: "fixed",
        title: "Last.fm avatar",
        text: "Your Last.fm profile picture now shows up in the Integrations tab.",
      },
      {
        type: "fixed",
        title: "Collapsed sidebar",
        text: "Fixed clicks not landing on the Library button and the Sign in button sitting off-center.",
      },
    ],
    note: "I need your help with the macOS and Linux versions. I put them together from pull requests by [ameenalasady](https://github.com/NUber-dev/YTubic/pull/1) and [yuvrajangadsingh](https://github.com/NUber-dev/YTubic/pull/33), but I have no way to run and test them myself, so they may not work at all. I've created a Discord server so we have an easier place to discuss future fixes, suggestions, and improvements: https://discord.gg/v7JGAWWWj",
  },
  {
    version: "0.3.2",
    date: "July 11, 2026",
    summary: "Last.fm connections fixed for good",
    changes: [
      {
        type: "fixed",
        title: "Last.fm connection",
        text: 'Connecting a Last.fm account failed with an "Invalid API key" error in 0.3.0 and 0.3.1 because the release pipeline corrupted the API credentials. Head to the Integrations tab and connect your account.',
      },
    ],
  },
  {
    version: "0.3.1",
    date: "July 11, 2026",
    summary: "Last.fm scrobbling switched back on",
    changes: [
      {
        type: "fixed",
        title: "Last.fm credentials",
        text: "Version 0.3.0 shipped with Last.fm scrobbling switched off because the release build was missing its API credentials. This update turns it back on.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "July 11, 2026",
    summary: "Discord Rich Presence and Last.fm scrobbling",
    image: "/whats-new/0.3.0.jpg",
    changes: [
      {
        type: "new",
        title: "Discord Rich Presence",
        text: "Show what you're listening to on your Discord profile, complete with album art and a progress bar. Turn it on in Settings under the new Integrations tab.",
      },
      {
        type: "new",
        title: "Last.fm scrobbling",
        text: "Connect your Last.fm account to scrobble every track you play. Liking a song on YTubic loves it on Last.fm, and unliking removes it.",
      },
      {
        type: "improved",
        title: "Offline scrobble queue",
        text: "Scrobbles made while offline are queued and sent automatically once you're back online.",
      },
      {
        type: "fixed",
        title: "Mini player launch",
        text: "The floating mini player no longer fails to open after the 0.2.2 update.",
      },
    ],
  },
  {
    version: "0.2.2",
    date: "July 10, 2026",
    summary: "Sidebar playlists and the session fix",
    changes: [
      {
        type: "new",
        title: "Your playlists in the sidebar",
        text: "The sidebar now lists every playlist in your library, not just the ones you pinned. Pin a playlist to keep it at the top, or hide the ones you never open.",
      },
      {
        type: "improved",
        title: "Storage settings",
        text: "The Storage tab now shows real song titles for every cached track, plus when the next auto-clean is due.",
      },
      {
        type: "fixed",
        title: "Session expiration",
        text: "Finally fixed the bug where all songs and playlists would disappear from the library after two hours and the session would show as expired.",
      },
      {
        type: "fixed",
        title: "Windows media tile",
        text: 'The Now Playing tile no longer shows "Unknown app" instead of YTubic\'s name and icon.',
      },
      {
        type: "fixed",
        title: "Playback reliability",
        text: "Fixed a bug where some songs wouldn't load, or wouldn't load on the first try.",
      },
    ],
    alert:
      "Make sure to re-log into your account after the update to refresh the session.",
  },
  {
    version: "0.2.1",
    date: "July 8, 2026",
    summary: "Session drop bug fixed",
    changes: [
      {
        type: "fixed",
        title: "Session drops",
        text: "Version 0.2.0 had a bug where your session quietly dropped after a couple of hours: your library, playlists, and Premium status would suddenly disappear until you signed in again. This update fixes the cause. Thanks to everyone who reported it.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "July 7, 2026",
    summary: "Settings dialog and account switching",
    image: "/whats-new/0.2.0.png",
    changes: [
      {
        type: "new",
        title: "Settings",
        text: "A proper Settings dialog with General, Appearance, and Storage tabs: launch at startup, playback notifications, and a cache folder you can relocate.",
      },
      {
        type: "new",
        title: "Accounts",
        text: "Switch between the YouTube channels on one Google account; your library and likes follow the channel you pick. Sign in straight from the sidebar when you're logged out.",
      },
    ],
    note: "I really didn't want to lock playback behind anything, but YouTube's Terms of Service require ads to play and YTubic has no way to show them. To keep the project alive without breaking those terms, playback and caching now need an active YouTube Music Premium subscription. Browsing and search stay open to everyone, and YTubic itself stays completely free and open source. Thanks for understanding.",
  },
  {
    version: "0.1.0",
    date: "July 5, 2026",
    summary: "The first public release of YTubic",
    image: "/whats-new/0.1.0.jpg",
    imageAlign: "top",
    changes: [
      {
        type: "new",
        title: "YTubic for desktop",
        text: "Stream your full YouTube Music library in a native desktop app: playback, search, playlists, and your likes, wrapped in a fast dark UI.",
      },
    ],
  },
];

/** The entry for a specific version, if one exists. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((e) => e.version === version);
}
