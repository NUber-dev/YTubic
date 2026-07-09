import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircleIcon,
  ChevronRightIcon,
  HistoryIcon,
  Loader2Icon,
  LogInIcon,
  PlayIcon,
  SearchIcon,
  ShuffleIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchSearch,
  GROUP_FILTER,
  type SearchFilter,
  type SearchGroup,
} from "@/lib/innertube/search";
import {
  fetchPlaylistContinuation,
  fetchPlaylistFirstPage,
} from "@/lib/innertube/playlist";
import { fetchWatchQueue } from "@/lib/innertube/radio";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { ShelfCard } from "@/components/shared/shelf-card";
import { TrackList } from "@/components/shared/track-list";
import { Thumbnail } from "@/components/shared/thumbnail";
import { TrackContextMenu } from "@/components/shared/track-context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useSearchHistory } from "@/lib/store/search-history";
import { usePlaybackStore } from "@/lib/store/playback";
import { openSettings } from "@/lib/store/settings-dialog";
import { cn } from "@/lib/utils";
import type {
  Shelf,
  SearchResults,
  ShelfItem,
  TopResultAction,
} from "@/lib/innertube/types";

type SearchParams = {
  q?: string;
  filter?: SearchFilter;
};

export const Route = createFileRoute("/search")({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: typeof search.q === "string" ? search.q : undefined,
    filter:
      typeof search.filter === "string" &&
      ["all", "songs", "videos", "albums", "artists", "playlists"].includes(
        search.filter,
      )
        ? (search.filter as SearchFilter)
        : undefined,
  }),
});

const FILTERS: SearchFilter[] = [
  "all",
  "songs",
  "albums",
  "artists",
  "playlists",
  "videos",
];
const HISTORY_LIMIT = 5;

/** Search scope: the public YTM catalog, or only the signed-in user's songs. */
type Scope = "catalog" | "library";

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function SearchPage() {
  const { q = "", filter = "all" } = Route.useSearch();
  const [scope, setScope] = useState<Scope>("catalog");

  const query = q.trim();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["search", query, filter],
    queryFn: () => fetchSearch(query, filter),
    enabled: query.length > 0 && scope === "catalog",
    staleTime: 30_000,
  });

  // Lifted here (not inside LibraryResults) so the result count can sit up in
  // the controls row — where the catalog filter chips live — instead of above
  // the list.
  const library = useLibrarySearch(
    query,
    scope === "library" && query.length > 0,
  );
  const libraryCount =
    scope === "library" &&
    query &&
    library.isLoggedIn &&
    !library.isLoading &&
    library.matches.length > 0
      ? `${library.matches.length} ${
          library.matches.length === 1 ? "song" : "songs"
        } in your library${library.truncated ? " (most recent)" : ""}`
      : null;

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">
          {query ? `Results for "${query}"` : "Search"}
        </h1>
        {scope === "catalog" && isFetching && !isLoading ? (
          <span className="text-xs text-muted-foreground">Searching…</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <SearchField filter={filter} urlQ={q} className="w-full" />
        <div className="flex items-center gap-3">
          {scope === "catalog" ? (
            <FilterBar filter={filter} />
          ) : (
            <h2 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
              {libraryCount}
            </h2>
          )}
          <ScopeToggle scope={scope} onChange={setScope} className="ml-auto" />
        </div>
      </div>

      {!query ? null : scope === "library" ? (
        <LibraryResults state={library} query={query} />
      ) : error ? (
        <ErrorCard message={(error as Error).message} />
      ) : isLoading ? (
        <SearchSkeleton variant={filter === "songs" ? "list" : "shelves"} />
      ) : !data ? null : filter === "all" ? (
        <AllResults data={data} />
      ) : (
        <FilterResults data={data} filter={filter} />
      )}
    </div>
  );
}

function FilterChip({
  filter,
  active,
}: {
  filter: SearchFilter;
  active: boolean;
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <button
      type="button"
      onClick={() =>
        navigate({ search: (s) => ({ ...s, filter }), replace: true })
      }
      className={cn(
        "cursor-pointer rounded-full border px-3.5 py-1 text-sm font-medium transition-colors",
        active
          ? "border-transparent bg-foreground text-background"
          : "border-input bg-transparent text-foreground hover:bg-black/5 dark:bg-input/30 dark:hover:bg-white/15",
      )}
    >
      {filter.charAt(0).toUpperCase() + filter.slice(1)}
    </button>
  );
}

// The filter chips live in a horizontal scroller so a narrow window keeps the
// controls on one line (chips scroll) instead of wrapping the scope toggle to
// a second row. Edge fades (same as the shelf carousels) hint at hidden chips.
function FilterBar({ filter }: { filter: SearchFilter }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const RAMP = 48;
    const update = () => {
      const left = el.scrollLeft;
      const right = el.scrollWidth - el.clientWidth - left;
      el.style.setProperty("--fade-l", Math.max(0, 1 - left / RAMP).toFixed(3));
      el.style.setProperty(
        "--fade-r",
        Math.max(0, 1 - right / RAMP).toFixed(3),
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={scrollRef}
      className="shelf-edge-fade min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max gap-1.5 py-0.5">
        {FILTERS.map((f) => (
          <FilterChip key={f} filter={f} active={filter === f} />
        ))}
      </div>
    </div>
  );
}

function ScopeToggle({
  scope,
  onChange,
  className,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex shrink-0 rounded-full border border-input p-0.5",
        className,
      )}
    >
      {(
        [
          ["catalog", "Catalog"],
          ["library", "My library"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "cursor-pointer rounded-full px-3 py-1 text-sm font-medium transition-colors",
            scope === value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "all" tab — top-result hero + per-type sections
// ---------------------------------------------------------------------------

// The "all" tab shows a preview of each type. The unfiltered YTM response only
// carries ~3 of each, so every section is *enriched* from its dedicated filter
// query (up to ~20 results) — reusing the same cache key as the filter tab, so
// the flat list paints instantly and then upgrades, and switching to a filter
// tab / "Show all" is a cache hit. Songs stay a short list; the rest are
// scrollable carousels capped to a generous preview.
const ALL_SECTIONS: {
  filter: SearchFilter;
  title: string;
  display: "list" | "card";
  cap: number;
}[] = [
  { filter: "songs", title: "Songs", display: "list", cap: 8 },
  { filter: "artists", title: "Artists", display: "card", cap: 15 },
  { filter: "albums", title: "Albums & singles", display: "card", cap: 15 },
  { filter: "videos", title: "Videos", display: "card", cap: 15 },
  {
    filter: "playlists",
    title: "Community playlists",
    display: "card",
    cap: 15,
  },
];

function AllResults({ data }: { data: SearchResults }) {
  const { topResult, query } = data;

  // Per-type items from the single "all" response — the instant first paint.
  const fallback = useMemo(() => {
    const m = new Map<SearchFilter, ShelfItem[]>();
    for (const shelf of data.shelves) {
      const group = shelf.id.slice("all-".length) as SearchGroup;
      const f = GROUP_FILTER[group];
      if (f) m.set(f, shelf.items);
    }
    return m;
  }, [data.shelves]);

  const enrich = useQueries({
    queries: ALL_SECTIONS.map((s) => ({
      queryKey: ["search", query, s.filter],
      queryFn: () => fetchSearch(query, s.filter),
      enabled: query.length > 0,
      staleTime: 30_000,
    })),
  });

  // The promoted entity is also the #1 hit in its own filter tab, so drop it
  // from that section to avoid showing it twice (hero + first card). Filter
  // before capping so removing it doesn't shrink the preview below its count.
  const topKey = topResult ? `${topResult.kind}:${topResult.id}` : null;
  const sections = ALL_SECTIONS.map((s, i) => {
    const enriched = enrich[i].data?.shelves.flatMap((sh) => sh.items) ?? [];
    const source = enriched.length ? enriched : (fallback.get(s.filter) ?? []);
    const deduped = topKey
      ? source.filter((it) => `${it.kind}:${it.id}` !== topKey)
      : source;
    return {
      ...s,
      items: deduped.slice(0, s.cap),
      loading: enrich[i].isLoading,
    };
  });

  const hasAny = Boolean(topResult) || sections.some((s) => s.items.length > 0);
  const stillLoading = sections.some((s) => s.loading);
  if (!hasAny && !stillLoading) {
    // Nothing to show and every section settled — distinguish a genuine empty
    // result from a transient failure where all enrichment queries errored.
    const enrichError = enrich.find((e) => e.isError)?.error as
      Error | undefined;
    if (!topResult && enrichError && enrich.every((e) => e.isError)) {
      return <ErrorCard message={enrichError.message} />;
    }
    return <NoResults query={query} />;
  }

  return (
    <div className="flex flex-col gap-8">
      {topResult ? (
        <TopResultHero item={topResult} action={data.topResultAction} />
      ) : null}

      {sections.map((s) => {
        if (s.items.length === 0) {
          return s.loading ? (
            <ShelfSkeleton key={s.filter} title={s.title} display={s.display} />
          ) : null;
        }

        const showAll = (
          <Link
            to="/search"
            search={{ q: query, filter: s.filter }}
            replace
            className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Show all
            <ChevronRightIcon className="size-4" />
          </Link>
        );

        if (s.display === "list") {
          return (
            <section key={s.filter} className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3 px-1">
                <h2 className="truncate text-xl font-semibold tracking-tight">
                  {s.title}
                </h2>
                {showAll}
              </div>
              <TrackList tracks={s.items} />
            </section>
          );
        }

        const shelf: Shelf = {
          id: `all-${s.filter}`,
          title: s.title,
          items: s.items,
        };
        return <ShelfCarousel key={s.filter} shelf={shelf} action={showAll} />;
      })}
    </div>
  );
}

function TopResultHero({
  item,
  action,
}: {
  item: ShelfItem;
  action?: TopResultAction;
}) {
  const [pending, setPending] = useState(false);
  const radius = item.round
    ? "rounded-full"
    : item.kind === "album" || item.kind === "playlist"
      ? "rounded-lg"
      : "rounded-md";
  const isEntity =
    item.kind === "artist" || item.kind === "album" || item.kind === "playlist";

  const runAction = async () => {
    if (!action || pending) return;
    const store = usePlaybackStore.getState();
    if (action.videoId) {
      store.playNow(item);
      return;
    }
    if (!action.playlistId) return;
    setPending(true);
    try {
      const tracks = await fetchWatchQueue(action.playlistId);
      if (tracks.length) store.playShelfItems(tracks, 0);
      else toast.error("Couldn't start playback — no tracks returned.");
    } catch (e) {
      toast.error(`Couldn't start playback: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  // The whole card is the click target: a full-bleed link (entity) or play
  // button (song/video) sits behind the content, which is pointer-events-none
  // so clicks fall through to it. Only the Shuffle/Play button opts back into
  // pointer events (it layers on top), so it triggers its own action.
  const overlayCls =
    "absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  const overlay =
    item.kind === "artist" ? (
      <Link
        to="/artist/$id"
        params={{ id: item.id }}
        aria-label={item.title}
        className={overlayCls}
      />
    ) : item.kind === "album" ? (
      <Link
        to="/album/$id"
        params={{ id: item.id }}
        aria-label={item.title}
        className={overlayCls}
      />
    ) : item.kind === "playlist" ? (
      <Link
        to="/playlist/$id"
        params={{ id: item.id }}
        aria-label={item.title}
        className={overlayCls}
      />
    ) : (
      <button
        type="button"
        aria-label={`Play ${item.title}`}
        onClick={() => usePlaybackStore.getState().playNow(item)}
        className={cn(overlayCls, "cursor-pointer")}
      />
    );

  const card = (
    <div className="relative flex items-center gap-3 rounded-xl border bg-card/40 p-4 pr-5 transition-colors hover:bg-white/[0.06]">
      {overlay}

      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-5">
        <div className={cn("relative size-24 shrink-0 md:size-28", radius)}>
          <Thumbnail
            thumbnails={item.thumbnails}
            alt={item.title}
            round={item.round}
            className={cn("size-full", radius)}
            targetSize={320}
            highRes
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 border border-hairline",
              radius,
            )}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-3xl font-bold tracking-tight">
            {item.title}
          </span>
          {item.subtitle ? (
            <span className="truncate text-sm text-muted-foreground">
              {item.subtitle}
            </span>
          ) : null}
        </div>
      </div>

      {action ? (
        <button
          type="button"
          onClick={runAction}
          disabled={pending}
          aria-label={action.label}
          className="pointer-events-auto relative z-10 inline-flex shrink-0 items-center gap-2 rounded-full border border-input bg-white/5 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/10 disabled:opacity-60"
        >
          {pending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : action.kind === "shuffle" ? (
            <ShuffleIcon className="size-4" />
          ) : (
            <PlayIcon className="size-4 fill-current" />
          )}
          {action.label}
        </button>
      ) : null}

      {isEntity ? (
        <ChevronRightIcon className="pointer-events-none relative size-6 shrink-0 text-muted-foreground" />
      ) : null}
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-xl font-semibold tracking-tight">Top result</h2>
      {item.kind === "song" || item.kind === "video" ? (
        <TrackContextMenu item={item}>{card}</TrackContextMenu>
      ) : (
        card
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A single filter tab (Songs / Artists / Albums / …) — full-page list or grid
// ---------------------------------------------------------------------------

function FilterResults({
  data,
  filter,
}: {
  data: SearchResults;
  filter: SearchFilter;
}) {
  const items = useMemo(
    () => data.shelves.flatMap((s) => s.items),
    [data.shelves],
  );

  if (items.length === 0) return <NoResults query={data.query} />;

  // Songs read best as the familiar dense table; everything else fills the
  // page as a responsive card grid instead of a single horizontal row.
  if (filter === "songs") return <TrackList tracks={items} />;

  const gridClass =
    filter === "videos"
      ? "grid w-full gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))]"
      : "grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] [&>*]:max-w-[20rem]";

  return (
    <div className={gridClass}>
      {items.map((item) => (
        <ShelfCard key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "My library" scope — filter the signed-in user's liked songs client-side
// ---------------------------------------------------------------------------

// Cap how many liked-songs pages we page through before filtering, so a huge
// library doesn't fan out into dozens of continuation calls on every search.
const LIBRARY_MAX_PAGES = 20;

type LibrarySearchState = {
  isLoggedIn: boolean;
  loggedInKnown: boolean;
  isLoading: boolean;
  error: Error | null;
  matches: ShelfItem[];
  truncated: boolean;
};

/**
 * Filter the signed-in user's liked songs by the query, client-side. Lifted
 * to a hook so both the controls row (the result count) and the list body
 * share one query/computation.
 */
function useLibrarySearch(query: string, enabled: boolean): LibrarySearchState {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  const lib = useQuery({
    queryKey: ["library", "liked-songs-all"],
    enabled: enabled && loggedIn.data === true,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const first = await fetchPlaylistFirstPage("LM");
      let tracks = first.tracks;
      let token = first.continuationToken;
      let pages = 1;
      while (token && pages < LIBRARY_MAX_PAGES) {
        const next = await fetchPlaylistContinuation(token);
        tracks = tracks.concat(next.tracks);
        token = next.continuationToken;
        pages += 1;
      }
      return { tracks, truncated: Boolean(token) };
    },
  });

  const needle = query.toLowerCase();
  const matches = useMemo(() => {
    const all = lib.data?.tracks ?? [];
    if (!needle) return all;
    return all.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        (t.subtitle?.toLowerCase().includes(needle) ?? false) ||
        (t.album?.toLowerCase().includes(needle) ?? false) ||
        (t.artists?.some((a) => a.name.toLowerCase().includes(needle)) ??
          false),
    );
  }, [lib.data, needle]);

  return {
    isLoggedIn: loggedIn.data === true,
    loggedInKnown: loggedIn.data !== undefined,
    isLoading: loggedIn.isLoading || lib.isLoading,
    error: (lib.error as Error) ?? null,
    matches,
    truncated: lib.data?.truncated ?? false,
  };
}

function LibraryResults({
  state,
  query,
}: {
  state: LibrarySearchState;
  query: string;
}) {
  if (state.loggedInKnown && !state.isLoggedIn) return <LibrarySignInHint />;
  if (state.isLoading) return <SearchSkeleton variant="list" />;
  if (state.error) return <ErrorCard message={state.error.message} />;
  if (state.matches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No songs in your library match "{query}".
      </p>
    );
  }
  return <TrackList tracks={state.matches} />;
}

function LibrarySignInHint() {
  return (
    <div className="flex flex-col items-center gap-4 p-12 text-center">
      <LogInIcon className="size-12 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">
          Sign in to search your library
        </h2>
        <p className="text-sm text-muted-foreground">
          Import your YouTube Music session to search your liked songs.
        </p>
      </div>
      <button
        type="button"
        onClick={() => openSettings("general")}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Go to Settings
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search input
// ---------------------------------------------------------------------------

function SearchField({
  filter,
  urlQ,
  className,
}: {
  filter: SearchFilter;
  urlQ: string;
  className?: string;
}) {
  const navigate = useNavigate({ from: Route.fullPath });

  const [value, setValue] = useState(urlQ);
  const debounced = useDebounced(value, 300);
  const userTypedRef = useRef(false);

  const history = useSearchHistory((s) => s.items);
  const pushHistory = useSearchHistory((s) => s.push);
  const clearHistory = useSearchHistory((s) => s.clear);

  // External URL changes flow into the input (e.g. clicking a history
  // entry that calls navigate, or hitting Back).
  useEffect(() => {
    setValue(urlQ);
    userTypedRef.current = false;
  }, [urlQ]);

  // As the user types, mirror the value into the URL so the route
  // re-runs the search query. Replace history while staying on /search
  // so Back returns to whatever page got the user here, not every
  // keystroke.
  useEffect(() => {
    if (!userTypedRef.current) return;
    if (debounced === urlQ) return;
    navigate({
      to: "/search",
      search: { q: debounced || undefined, filter },
      replace: true,
    });
  }, [debounced, urlQ, filter, navigate]);

  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus the field whenever the route mounts so opening the
  // Search tab from the sidebar drops the user straight into typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return history.slice(0, HISTORY_LIMIT);
    return history
      .filter((h) => h.toLowerCase().includes(q) && h.toLowerCase() !== q)
      .slice(0, HISTORY_LIMIT);
  }, [history, value]);

  useEffect(() => {
    setActiveIdx(-1);
  }, [suggestions.length, focused]);

  const showDropdown = focused && suggestions.length > 0;

  const submitQuery = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    pushHistory(trimmed);
    userTypedRef.current = true;
    setValue(trimmed);
    setFocused(false);
    inputRef.current?.blur();
    navigate({
      to: "/search",
      search: { q: trimmed, filter },
    });
  };

  const clear = () => {
    userTypedRef.current = true;
    setValue("");
    inputRef.current?.focus();
    navigate({
      to: "/search",
      search: { q: undefined, filter },
      replace: true,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (value) {
        clear();
        return;
      }
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (activeIdx >= 0 && suggestions[activeIdx]) {
            submitQuery(suggestions[activeIdx]);
          } else {
            submitQuery(value);
          }
        }}
      >
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          placeholder="Search songs, albums, artists…"
          className="pl-9 pr-9"
          value={value}
          onChange={(e) => {
            userTypedRef.current = true;
            setValue(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (
              containerRef.current?.contains(e.relatedTarget as Node | null)
            ) {
              return;
            }
            setFocused(false);
          }}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={clear}
            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </form>

      {showDropdown && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <ul className="py-1">
            {suggestions.map((h, i) => (
              <li key={h}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    i === activeIdx ? "bg-accent" : "hover:bg-accent",
                  )}
                  onClick={() => submitQuery(h)}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{h}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent"
              onClick={() => {
                clearHistory();
                setFocused(false);
                inputRef.current?.blur();
              }}
            >
              Clear search history
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function NoResults({ query }: { query: string }) {
  return (
    <p className="text-sm text-muted-foreground">No results for "{query}".</p>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
      <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
      <div className="flex flex-col gap-1">
        <span className="font-medium">Search failed</span>
        <span className="text-muted-foreground">{message}</span>
      </div>
    </div>
  );
}

function ShelfSkeleton({
  title,
  display = "card",
}: {
  title: string;
  display?: "list" | "card";
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-xl font-semibold tracking-tight text-muted-foreground/60">
        {title}
      </h2>
      {display === "list" ? (
        <div className="flex flex-col gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="size-10 shrink-0 rounded-sm" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
              <Skeleton className="h-3 w-10 shrink-0" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-44 shrink-0 md:w-48 lg:w-52">
              <div className="flex flex-col gap-2 p-2">
                <Skeleton className="aspect-square w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SearchSkeleton({
  variant = "shelves",
}: {
  variant?: "shelves" | "list";
}) {
  if (variant === "list") {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-6 w-32" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-2">
            <Skeleton className="size-10 shrink-0 rounded-sm" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: 3 }).map((_, shelfIdx) => (
        <section key={shelfIdx} className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-44 shrink-0 md:w-48 lg:w-52">
                <div className="flex flex-col gap-2 p-2">
                  <Skeleton className="aspect-square w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
