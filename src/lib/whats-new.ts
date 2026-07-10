export type WhatsNewSection = {
  heading?: string;
  /** Bulleted list of changes. */
  items?: string[];
  /**
   * Prose message rendered as a soft note panel instead of bullets.
   * Use for a personal note from the developer rather than a change
   * list. Ignored when `items` is present.
   */
  body?: string;
  /**
   * Short call-to-action rendered as a yellow alert panel below the
   * items or body. Use for a must-read instruction, e.g. signing in
   * again after an update.
   */
  alert?: string;
};

export type WhatsNewEntry = {
  /** Semver string, e.g. "0.2.0", matched against the running app version. */
  version: string;
  /** Display date, pre-formatted so there's no locale work at runtime. */
  date: string;
  /**
   * Bundled hero image served from `/public`, e.g.
   * "/whats-new/0.2.0.jpg". Omit to fall back to the branded gradient
   * banner rendered by the dialog.
   */
  image?: string;
  sections: WhatsNewSection[];
};

/**
 * Curated release notes for the What's New dialog, newest first. The
 * dialog shows the entry whose version matches the running app (or the
 * newest one when opened manually). Add an entry here for every
 * user-facing release; keep the copy free of em/en dashes.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: "0.2.2",
    date: "July 2026",
    sections: [
      {
        heading: "Your playlists in the sidebar",
        items: [
          "The sidebar now lists every playlist in your library, not just the ones you pinned.",
          "Pin a playlist to keep it at the top, or hide the ones you never open.",
        ],
      },
      {
        heading: "Storage settings",
        items: [
          "The Storage tab now shows real song titles for every cached track, plus when the next auto-clean is due.",
        ],
      },
      {
        heading: "Fixes",
        items: [
          "Fixed the Windows Now Playing tile showing \"Unknown app\" instead of YTubic's name and icon.",
          "Fixed a bug where some songs wouldn't load, or wouldn't load on the first try.",
        ],
      },
      {
        heading: "Bug with session expiration and library disappearing",
        items: [
          "Finally fixed the bug where after 2 hours all songs and playlists would disappear from the library and the session would become expired.",
        ],
        alert:
          "Make sure to re-log into your account after the update to refresh the session.",
      },
    ],
  },
  {
    version: "0.2.1",
    date: "July 2026",
    sections: [
      {
        heading: "Bug fix",
        body: "Version 0.2.0 had a bug where your session quietly dropped after a couple of hours of use: your library, playlists, and Premium status would suddenly disappear until you signed in again. This update fixes the cause, so your account stays signed in the way it should. Thanks to everyone who reported it.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "July 2026",
    image: "/whats-new/0.2.0.png",
    sections: [
      {
        heading: "Settings",
        items: [
          "A proper Settings dialog with General, Appearance, and Storage tabs, replacing the old settings page.",
          "Launch at startup, playback notifications, and a cache folder you can relocate.",
        ],
      },
      {
        heading: "Accounts",
        items: [
          "Switch between the YouTube channels on one Google account. Your library and likes follow the channel you pick.",
          "Sign in straight from the sidebar when you're logged out.",
        ],
      },
      {
        heading: "A note from the developer",
        body: "I really didn't want to lock playback behind anything, but YouTube's Terms of Service require ads to play and YTubic has no way to show them. To keep the project alive without breaking those terms, playback and caching now need an active YouTube Music Premium subscription. Browsing and search stay open to everyone, and YTubic itself stays completely free and open source. Thanks for understanding.",
      },
    ],
  },
];

/** The entry for a specific version, if one exists. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((e) => e.version === version);
}
