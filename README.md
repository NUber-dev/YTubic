<p align="center">
  <img src="assets/branding/ytubic-icon.svg" alt="YTubic" width="96" />
</p>

<h1 align="center">YTubic</h1>

<p align="center">
  A fast, responsive YouTube Music desktop client for Windows, Linux, and macOS.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL-3.0" /></a>
</p>

<p align="center">
  <a href="../../releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download%20YTubic-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Download YTubic" height="60" />
  </a>
  <a href="https://discord.gg/4gccUpZyYH">
    <img src="https://img.shields.io/badge/Join%20the%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join the YTubic Discord" height="60" />
  </a>
</p>

Built as a reaction to the sluggish webview-wrapper experience — YTubic talks to YouTube's InnerTube API directly, renders its own UI, and caches aggressively, so navigation and playback feel instant.

![YTubic — artist page with the player and synced lyrics](assets/screenshots/artist-page.jpg)

## Features

- **Fast and responsive UI** — instant navigation with prefetch and aggressive caching; no page reloads, no spinners on every click
- **Flexible player layouts** — dock the player at the bottom or as a right-side panel
- **Floating player widget** — pop the player out into a compact always-on-top window
- **Synced lyrics** — line-by-line synced lyrics from multiple providers (LRCLIB, Musixmatch, Genius)
- **Hi-res cover art** — upgrades album covers to high-resolution studio art when available
- **Full library support** — your playlists, likes, albums and artists; search with filters; radio/autoplay queues
- **Desktop integration** — media keys and system media controls, tray/menu-bar icon, single instance
- **Auto-updates** — the app updates itself from GitHub Releases, and keeps its yt-dlp copy fresh automatically

> **Disclaimer:** YTubic is an unofficial client. It is not affiliated with,
> endorsed by, or sponsored by Google or YouTube. "YouTube" and "YouTube Music"
> are trademarks of Google LLC. The app streams audio through
> [yt-dlp](https://github.com/yt-dlp/yt-dlp) and may stop working at any time if
> YouTube changes its internals. Use at your own risk.

## Install

Download the latest installer from the [Releases](../../releases) page and run it.

- **Windows 10/11:** run the `.exe` NSIS installer. Pick the `x64` build, or
  the `arm64` one on a Windows on ARM device.
- macOS 13.5+ (beta): open the universal `.dmg`; the same build supports Apple Silicon and Intel. The managed Node playback runtime requires macOS 13.5 or later. Login cookies are encrypted with a Keychain-backed key.
- Linux (beta): install the `.deb` or `.rpm`, or run the `.AppImage`. Playback requires WebKitGTK 4.1, GTK 3, the GStreamer base, good and libav plugins, and `libatomic` for the managed Node runtime. The `.deb` and `.rpm` install those dependencies; AppImage users need to install them through their distribution. Signing in also requires a desktop Secret Service provider such as GNOME Keyring or a compatible KWallet setup.
- On first launch the app downloads its own copies of yt-dlp and Node into its data folder. It verifies the Node download against the official release checksum. yt-dlp updates automatically; the Node version is maintained with app releases.
- Browse without signing in, or sign in to get your library, likes, and playlists. Playback starts anonymously; if YouTube requires sign-in, the app retries using the selected account's saved session.

> **Linux and macOS builds are in beta.** They are compiled and unit-tested in
> CI, but get far less real-world testing than the Windows build. If something
> breaks, please [open an issue](../../issues) — or use the in-app reporter
> (⋯ menu → Report an issue), which attaches your app version and OS
> automatically.

### FAQ

**Windows says "Windows protected your PC" (SmartScreen).**
The installer is not code-signed (certificates are expensive for a free
open-source project). Click "More info" → "Run anyway". The source code is
public — you can audit it or build it yourself.

**macOS says YTubic can't be opened or is from an unidentified developer.**
Release builds are ad-hoc signed until Developer ID credentials are configured,
so they are not notarized. Open **System Settings → Privacy & Security** and
choose **Open Anyway**, or right-click YTubic in Applications and choose
**Open**. As a last resort, clear the downloaded quarantine attribute:

```bash
xattr -cr /Applications/YTubic.app
```

**My antivirus flags the app / yt-dlp.**
yt-dlp is a widely-used open-source downloader that some AV vendors
false-positive on. The binary is downloaded directly from yt-dlp's official
GitHub releases.

**Will Google ban my account for using this?**
Playback starts anonymously, but a retry after YouTube requests sign-in uses your selected account. Those requests are tied to that account. There is no guarantee against account restrictions; see the disclaimer above. The retry uses a temporary cookie file that is removed afterward, while the saved account cookies remain encrypted.

**Playback suddenly stopped working.**
YouTube periodically changes its streaming internals. yt-dlp usually ships a
fix within days, and the app picks it up automatically (it self-updates its
yt-dlp copy every ~3 days). Restarting the app forces the check.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview — WebView2 on Windows,
  WebKitGTK on Linux, WKWebView on macOS)
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

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build and Rust
tests on Windows, Linux, and macOS for every push / PR.

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

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — audio streaming
- [LRCLIB](https://lrclib.net) — synced lyrics
- Musixmatch and Genius — lyrics sources
- [Tauri](https://tauri.app), [shadcn/ui](https://ui.shadcn.com),
  [TanStack](https://tanstack.com), and the rest of the stack above

## License

[GPL-3.0](LICENSE) — free to use, modify, and redistribute; derivative works
must stay open source under the same license.
