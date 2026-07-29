<p align="center">
  <img src="assets/branding/ytubic-icon.svg" alt="YTubic" width="96" />
</p>

<h1 align="center">YTubic for macOS</h1>

<p align="center">
  A fast, responsive YouTube Music desktop client — the macOS port.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS — Apple Silicon" />
</p>

<p align="center">
  <a href="../../releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download%20for%20macOS-FF0000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="60" />
  </a>
</p>

> **This is the macOS port of [YTubic](https://github.com/NUber-dev/YTubic), built by [@NUber-dev](https://github.com/NUber-dev).**
> The app itself is their work — the original ships Windows-only. This fork carries the macOS
> support on top of it: native window chrome, system media controls, an Apple Music style
> fullscreen, video mode, and the login fix consumer Google accounts need on WKWebView.
> Same GPL-3.0 license as upstream. **On Windows? Use [the original](https://github.com/NUber-dev/YTubic)** — it has installers and auto-updates.

Built as a reaction to the sluggish webview-wrapper experience — YTubic talks to YouTube's InnerTube API directly, renders its own UI, and caches aggressively, so navigation and playback feel instant.

![YTubic — artist page with the player and synced lyrics](assets/screenshots/artist-page.jpg)

## What the macOS port adds

Everything below is on top of upstream's app:

- **Native Mac window** — traffic lights on the overlay titlebar, window edges melted into the app chrome
- **System media controls** — Now Playing in Control Center and on the lock screen, media keys, playback state kept in sync both ways
- **Apple Music style fullscreen** — ambient backdrop that crossfades, notch band blended into the artwork
- **Video mode** — watch the video version of a track, 1080p/1440p/4K through a YouTube style quality picker that only offers tiers the video actually has
- **Better synced lyrics** — picks the right record instead of the closest one, auto-aligns padded intros, manual nudges stick to the track
- **Search history** — recent queries saved and surfaced on the empty search page
- **Sign-in that works** — consumer Google accounts get "this browser may not be secure" on WKWebView; the port fixes the user agent so login goes through

## Features

- **Fast and responsive UI** — instant navigation with prefetch and aggressive caching; no page reloads, no spinners on every click
- **Flexible player layouts** — dock the player at the bottom or as a right-side panel
- **Floating player widget** — pop the player out into a compact always-on-top window
- **Synced lyrics** — line-by-line synced lyrics from multiple providers (LRCLIB, Musixmatch, Genius)
- **Hi-res cover art** — upgrades album covers to high-resolution studio art when available
- **Full library support** — your playlists, likes, albums and artists; search with filters; radio/autoplay queues
- **macOS integration** — media keys, Now Playing in Control Center and on the lock screen, single instance
- **yt-dlp stays current** — the app keeps its own yt-dlp copy updated automatically (the app's own auto-updater is Windows-only; on macOS you grab a new build from Releases)

> **Disclaimer:** YTubic is an unofficial client. It is not affiliated with,
> endorsed by, or sponsored by Google or YouTube. "YouTube" and "YouTube Music"
> are trademarks of Google LLC. The app streams audio through
> [yt-dlp](https://github.com/yt-dlp/yt-dlp) and may stop working at any time if
> YouTube changes its internals. Use at your own risk.

## Install

1. Download the `.dmg` from the [Releases](../../releases/latest) page.
2. Open it and drag **YTubic** onto the Applications folder.
3. macOS will refuse to open it the first time — see the FAQ right below.

- **Apple Silicon only** (M1/M2/M3/M4). Intel Macs are not supported.
- On first launch the app downloads its own copy of yt-dlp (~12 MB) into its
  data folder and keeps it updated automatically. The first song takes a
  moment because of this; after that it is fast.
- Signing in is optional: browse and playback work anonymously; sign in to get
  your library, likes, and playlists.

### FAQ

**macOS says "Apple could not verify YTubic is free of malware".**
The app is not signed with an Apple Developer certificate (they cost $99/yr,
which is a lot for a free open-source port). It is not malware. Open Terminal
and run:

```bash
xattr -cr /Applications/YTubic.app
```

then open it normally. That command only removes the "downloaded from the
internet" quarantine flag. Prefer no Terminal? Try to open the app, let macOS
block it, then go to **System Settings → Privacy & Security**, scroll down and
click **Open Anyway**. The source is public — audit it or build it yourself.

**My antivirus flags the app / yt-dlp.**
yt-dlp is a widely-used open-source downloader that some AV vendors
false-positive on. The binary is downloaded directly from yt-dlp's official
GitHub releases.

**Will Google ban my account for using this?**
Browsing/search/library requests look identical to the official web app, and
audio streaming is fully anonymous (never tied to your account). There are no
known cases of accounts being banned for third-party players — but no
guarantees; see the disclaimer above.

**Playback suddenly stopped working.**
YouTube periodically changes its streaming internals. yt-dlp usually ships a
fix within days, and the app picks it up automatically (it self-updates its
yt-dlp copy every ~3 days). Restarting the app forces the check.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview — WKWebView on macOS)
- **Frontend:** React 19 + TypeScript
- **Build:** Vite 7
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui (new-york style, neutral base, YouTube red accent)
- **Routing:** TanStack Router (file-based, type-safe, prefetch on intent)
- **Data:** TanStack Query
- **Client state:** Zustand
- **Icons:** lucide-react

## Dev

```bash
pnpm install
pnpm tauri dev
```

Frontend-only dev (no Tauri window): `pnpm dev`.

## Quality checks

```bash
pnpm test         # vitest unit tests (pure parsers/matchers)
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm build        # tsc + vite production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build and
`cargo check` on every push / PR.

## Project layout

```
src/
├── routes/              # TanStack Router file-based routes
├── components/
│   ├── ui/              # shadcn primitives
│   ├── layout/          # AppShell, sidebar, topbar, player bar, floating player, lyrics
│   └── shared/          # Track list/rows, cards, shelves, context menus
├── lib/
│   ├── innertube/        # Raw InnerTube client + parsers
│   ├── lyrics/          # LRCLIB / Musixmatch / Genius sources + LRC parser
│   ├── store/           # Zustand stores
│   ├── audio-engine.ts  # Playback engine
│   ├── stream.ts        # Stream URL resolver (localhost proxy)
│   └── utils.ts         # cn() and friends
└── hooks/
src-tauri/               # Rust backend (axum stream proxy, cookies, tray)
```

## Credits

- **[YTubic](https://github.com/NUber-dev/YTubic) by [@NUber-dev](https://github.com/NUber-dev)** — the app this port is built on. Everything except the macOS work listed above is theirs.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — audio streaming
- [LRCLIB](https://lrclib.net) — synced lyrics
- Musixmatch and Genius — lyrics sources
- [Tauri](https://tauri.app), [shadcn/ui](https://ui.shadcn.com),
  [TanStack](https://tanstack.com), and the rest of the stack above

## License

[GPL-3.0](LICENSE) — free to use, modify, and redistribute; derivative works
must stay open source under the same license. This port keeps the original
license and copyright intact.
