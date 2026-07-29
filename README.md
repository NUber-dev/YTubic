<div align="center">
  <img src="assets/branding/ytubic-logo-full.svg" width="260"
       alt="YTubic" />

  <p><em>YouTube Music, as an actual Mac app.</em></p>

  <p>
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-2a2933?style=flat-square&labelColor=14131a" alt="macOS, Apple Silicon" />
    <img src="https://img.shields.io/badge/license-GPL--3.0-2a2933?style=flat-square&labelColor=14131a" alt="GPL-3.0 license" />
    <img src="https://img.shields.io/badge/unofficial-client-2a2933?style=flat-square&labelColor=14131a" alt="Unofficial client" />
  </p>

  <p>
    <a href="#install">Install</a> ·
    <a href="#what-you-get">What you get</a> ·
    <a href="#what-the-mac-port-adds">The Mac port</a> ·
    <a href="#building-it-yourself">Building it</a>
  </p>

  <a href="../../releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Download%20for%20macOS-FF0000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="52" />
  </a>

  <br /><br />

  <img src="assets/screenshots/artist-page.jpg" width="820"
       alt="An artist page in YTubic, with the player docked at the bottom and synced lyrics open on the right" />
</div>

<br />

YouTube Music in a browser tab is fine right up until you want it to behave like
an app — media keys that actually work, a Now Playing card in Control Center, a
window that doesn't vanish into thirty other tabs. YTubic is a desktop client
that talks to YouTube's API directly and draws its own interface instead of
wrapping the website, so pages open instantly and playback starts without the
spinner.

This repo is the **macOS port**. The app itself is
[@NUber-dev](https://github.com/NUber-dev)'s work and it ships Windows-only —
what's here is that app plus the Mac half: native window chrome, system media
controls, an Apple Music style fullscreen, video playback, and the sign-in fix
Google's consumer accounts need inside a Mac webview. Same GPL-3.0 license as
upstream. **On Windows?** [Use the original](https://github.com/NUber-dev/YTubic)
— it has a proper installer and updates itself.

## Install

About two minutes, and most of that is macOS being suspicious of you.

**1.** [Download the `.dmg`](../../releases/latest) and open it.

**2.** Drag **YTubic** onto the Applications folder.

**3.** Open it. macOS will refuse, saying *"Apple could not verify YTubic is free
of malware"* — that happens to every app not signed with Apple's $99-a-year
certificate, which this one isn't. Open **Terminal** and paste:

```bash
xattr -cr /Applications/YTubic.app
```

That clears the "downloaded from the internet" flag and nothing else. Open the
app again and it launches normally, this time and every time after.

**4.** Sign in with your Google account. If that account has YouTube Premium you
get no ads; without it, you get them.

You need an **Apple Silicon Mac** — M1 or newer, so anything from late 2020
onward. The first song stalls for a few seconds while the app fetches a small
streaming helper in the background; everything after that is quick.

<details>
<summary>I'd rather not touch Terminal</summary>

Try to open YTubic, let macOS block it, then go to **System Settings → Privacy &
Security** and scroll to the bottom. There'll be a line about YTubic being
blocked with an **Open Anyway** button next to it. Same result, more clicking.

</details>

<details>
<summary>Google says "this browser or app may not be secure"</summary>

That's Google refusing to sign a consumer account into a webview it doesn't
recognise. The port works around it by sending a Safari user agent on the login
window specifically, so if you're seeing this you're on an old build — grab the
[latest release](../../releases/latest).

</details>

<details>
<summary>Playback suddenly stopped working</summary>

YouTube changes its streaming internals every so often and everything breaks
until yt-dlp ships a fix, usually within days. The app updates its own copy of
yt-dlp every few days, and restarting it forces the check.

</details>

## What you get

- **Instant navigation** — pages are prefetched and cached, so moving around the
  library doesn't reload anything or spin
- **A player that moves** — dock it along the bottom or as a right-hand panel,
  or pop it out into a small always-on-top window
- **Synced lyrics** — line by line, pulled from LRCLIB and Musixmatch
- **Cover art at full size** — album art upgraded to the high-resolution studio
  version when one exists
- **Your whole library** — playlists, likes, albums, artists, search with
  filters, and radio queues that keep going
- **Mac media controls** — media keys, Now Playing in Control Center and on the
  lock screen, playback state kept in sync both ways

> **This is an unofficial client.** It isn't affiliated with, endorsed by, or
> sponsored by Google or YouTube; "YouTube" and "YouTube Music" are trademarks of
> Google LLC. Audio streams through [yt-dlp](https://github.com/yt-dlp/yt-dlp)
> and can break whenever YouTube changes its internals. Use at your own risk.

## What the Mac port adds

Everything above is upstream's. This is the part that makes it a Mac app:

- **A native window** — traffic lights sitting on an overlay titlebar, window
  edges melted into the app's own chrome instead of a grey frame
- **System media controls** — Now Playing in Control Center and on the lock
  screen, media keys, and the app's state staying in sync when you pause from
  either side
- **Apple Music style fullscreen** — an ambient backdrop that crossfades between
  tracks, with the notch band blended into the artwork rather than cutting it
- **Video mode** — watch the video version of a track at 1080p, 1440p or 4K,
  through a quality picker that only offers the tiers a given video actually has
- **Lyrics that pick the right record** — matched on identity rather than the
  closest guess, padded intros auto-aligned, and manual timing nudges that stick
  to the track instead of resetting
- **Search history** — recent queries saved and offered on the empty search page
- **Sign-in that works** — consumer Google accounts get rejected by a Mac webview
  until the login window presents itself as Safari, which this does

## Building it yourself

Needs Node 20+, Rust, and pnpm.

```bash
pnpm install
pnpm tauri dev            # run it
pnpm tauri build --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'   # build a .dmg
```

The build lands in `src-tauri/target/release/bundle/`. One gotcha worth knowing:
Tauri's output `.app` is only linker-signed, which macOS reads as tampering on
another machine — sign it before you hand it to anyone, otherwise they get
"YTubic is damaged" with no way past it:

```bash
codesign --force --deep --sign - YTubic.app
```

<details>
<summary>Checks, stack, and layout</summary>

```bash
pnpm test         # vitest unit tests (pure parsers/matchers)
pnpm lint         # eslint
pnpm format       # prettier --write
pnpm build        # tsc + vite production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, build and
`cargo check` on every push and PR.

Tauri 2 (Rust backend, WKWebView on macOS) with React 19 and TypeScript on the
front, built by Vite 7, styled with Tailwind v4 and shadcn/ui, routed by TanStack
Router, data through TanStack Query, client state in Zustand.

```
src/
├── routes/              # TanStack Router file-based routes
├── components/
│   ├── ui/              # shadcn primitives
│   ├── layout/          # AppShell, sidebar, topbar, player bar, floating player, lyrics
│   └── shared/          # Track list/rows, cards, shelves, context menus
├── lib/
│   ├── innertube/       # Raw InnerTube client + parsers
│   ├── lyrics/          # LRCLIB / Musixmatch sources + LRC parser
│   ├── store/           # Zustand stores
│   ├── audio-engine.ts  # Playback engine
│   └── stream.ts        # Stream URL resolver (localhost proxy)
└── hooks/
src-tauri/               # Rust backend (axum stream proxy, cookies, media session)
```

</details>

## Credits

**[YTubic](https://github.com/NUber-dev/YTubic) by
[@NUber-dev](https://github.com/NUber-dev)** — the app this port is built on.
Everything except the Mac work listed above is theirs.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) for audio streaming,
[LRCLIB](https://lrclib.net) and Musixmatch for synced lyrics, and
[Tauri](https://tauri.app), [shadcn/ui](https://ui.shadcn.com) and
[TanStack](https://tanstack.com) for the stack underneath.

## License

[GPL-3.0](LICENSE) — free to use, modify and redistribute; derivative works stay
open source under the same license. This port keeps the original copyright and
license intact.
