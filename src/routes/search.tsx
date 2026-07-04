import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  HistoryIcon,
  SearchIcon,
} from "lucide-react";
import { fetchSearch, type SearchFilter } from "@/lib/innertube/search";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { TrackList } from "@/components/shared/track-list";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useSearchHistory } from "@/lib/store/search-history";
import { cn } from "@/lib/utils";
import type { ShelfItem } from "@/lib/innertube/types";

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

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// "all" tab keeps only Songs / Artists / Albums sections, in that order.
// We hardcode hl=en in the InnerTube context, so shelf titles are always
// in English — "Top result" gets dropped here too (its first item kind
// is often "song" so the kind filter alone wouldn't catch it).
const ALL_TAB_KIND_ORDER: Record<string, number> = {
  song: 0,
  artist: 1,
  album: 2,
};

function SearchPage() {
  const { q = "", filter = "all" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const query = q.trim();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["search", query, filter],
    queryFn: () => fetchSearch(query, filter),
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const visibleShelves = useMemo(() => {
    if (!data) return [];
    if (filter !== "all") return data.shelves;
    return data.shelves
      .filter((s) => {
        if (s.title === "Top result") return false;
        const kind = s.items[0]?.kind ?? "";
        return kind in ALL_TAB_KIND_ORDER;
      })
      .sort(
        (a, b) =>
          (ALL_TAB_KIND_ORDER[a.items[0]?.kind ?? ""] ?? 99) -
          (ALL_TAB_KIND_ORDER[b.items[0]?.kind ?? ""] ?? 99),
      );
  }, [data, filter]);

  const songsList = useMemo<ShelfItem[]>(() => {
    if (!data || filter !== "songs") return [];
    const out: ShelfItem[] = [];
    for (const shelf of data.shelves) {
      for (const item of shelf.items) {
        if (item.kind === "song") out.push(item);
      }
    }
    return out;
  }, [data, filter]);

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">
          {query ? `Results for "${query}"` : "Search"}
        </h1>
        {isFetching && !isLoading ? (
          <span className="text-xs text-muted-foreground">Searching…</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <SearchField filter={filter} urlQ={q} className="w-full" />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const isActive = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() =>
                  navigate({
                    search: (s) => ({ ...s, filter: f }),
                    replace: true,
                  })
                }
                className={cn(
                  "cursor-pointer rounded-full border px-3.5 py-1 text-sm font-medium transition-colors",
                  isActive
                    ? "border-transparent bg-foreground text-background"
                    : "border-input bg-transparent text-foreground hover:bg-black/5 dark:bg-input/30 dark:hover:bg-white/15",
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

      {!query ? null : error ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">Search failed</span>
            <span className="text-muted-foreground">
              {(error as Error).message}
            </span>
          </div>
        </div>
      ) : isLoading ? (
        <SearchSkeleton variant={filter === "songs" ? "list" : "shelves"} />
      ) : filter === "songs" ? (
        songsList.length > 0 ? (
          <TrackList tracks={songsList} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No results for "{query}".
          </p>
        )
      ) : visibleShelves.length > 0 ? (
        <div className="flex flex-col gap-8">
          {visibleShelves.map((shelf) => (
            <ShelfCarousel key={shelf.id} shelf={shelf} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No results for "{query}".
        </p>
      )}
    </div>
  );
}

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
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
          className="pl-9"
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
