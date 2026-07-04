# ytm-native

Native-feeling YouTube Music desktop client.

Built as a reaction to the sluggish webview-wrapper experience — ytm-native talks to YouTube's InnerTube API directly, renders its own UI, and caches aggressively.

## Stack

- **Shell:** Tauri 2 (Rust backend, system webview — WebView2 on Windows)
- **Frontend:** React 19 + TypeScript
- **Build:** Vite 7
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui (new-york style, neutral base, YouTube red accent)
- **Routing:** TanStack Router (file-based, type-safe, prefetch on intent)
- **Data:** TanStack Query
- **Client state:** Zustand
- **Icons:** lucide-react

## Phase status

- [x] **Phase 0** — Scaffold: Tauri + React + shadcn + TanStack, app shell (sidebar, topbar, player bar placeholders), stub routes (Home/Search/Library/Settings)
- [ ] **Phase 1** — InnerTube client + auth (cookie import), real Home feed
- [ ] **Phase 2** — Artist/Album/Playlist pages, search, cached navigation
- [ ] **Phase 3** — Audio engine + player bar, MediaSession API
- [ ] **Phase 4** — Queue management, context menus, autoplay/radio
- [ ] **Phase 5** — Library (your playlists, liked songs), SQLite cache
- [ ] **Phase 6** — Aggressive caching, infinite scroll via continuations
- [ ] **Phase 7** — Windows SMTC, global media keys, tray, single-instance
- [ ] **Phase 8** — Settings, shortcuts, polish

## Dev

```bash
pnpm install
pnpm tauri dev
```

Frontend-only dev (no Tauri window): `pnpm dev`.

## Project layout

```
src/
├── routes/          # TanStack Router file-based routes
├── components/
│   ├── ui/          # shadcn primitives
│   ├── layout/      # AppShell, sidebar, topbar, player bar
│   ├── player/      # Audio engine, queue
│   └── shared/      # Song row, cards, etc.
├── lib/
│   ├── innertube/   # InnerTube client + parsers
│   ├── audio/       # Playback engine, stream resolver
│   ├── store/       # Zustand stores
│   └── utils.ts     # cn() and friends
└── hooks/
src-tauri/           # Rust backend
```
