import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  ArrowDownWideNarrowIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  DatabaseIcon,
  FolderIcon,
  FolderOpenIcon,
  HardDriveIcon,
  ImageIcon,
  LibraryIcon,
  Loader2Icon,
  LockIcon,
  MusicIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { PERIOD_MS as AUTO_CLEAN_PERIOD_MS } from "@/lib/cache-cleanup";
import { formatBytes, formatDateTime, formatRelative } from "@/lib/format";
import { fetchLibraryTracks } from "@/lib/innertube/library";
import { clearPrefetchMemo } from "@/lib/stream";
import { usePremiumStore } from "@/lib/store/premium";
import {
  useSettingsStore,
  type CacheAutoCleanPeriod,
} from "@/lib/store/settings";
import type { ShelfItem } from "@/lib/innertube/types";
import { cn } from "@/lib/utils";

export function StorageTab() {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  return (
    <>
      {/* Stat cards sit above the divided settings list — its own
          bottom padding is the only separation, no divider. */}
      <StorageStats />
      <TabPane>
        <CacheFolderGroup />
        {/* Auto-clean lives outside the premium-gated tracks group: the
            sweep prunes whatever is already on disk, so it stays useful
            (and visible) even when caching itself is gated off. */}
        <Group>
          <AutoCleanRow loggedIn={!!loggedIn.data} />
        </Group>
        <CoverCacheGroup />
        {/* The track list is intentionally the last block on the tab. */}
        <CacheGroupGate loggedIn={!!loggedIn.data} />
      </TabPane>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border bg-background p-4 shadow-xs dark:border-input dark:bg-input/30">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 text-foreground" />
        {label}
      </div>
      <span className="text-2xl font-bold tracking-tight tabular-nums leading-none">
        {value}
      </span>
    </div>
  );
}

/**
 * Headline numbers for the tab. Subscribes to the same query keys the
 * groups below use, so react-query dedupes the actual Tauri calls.
 */
function StorageStats() {
  const cache = useQuery({
    queryKey: ["cache-list"],
    queryFn: () => invoke<CacheEntry[]>("list_cache"),
  });
  const covers = useQuery({
    queryKey: ["cover-cache-stats"],
    queryFn: () =>
      invoke<{ count: number; bytes: number }>("cover_cache_stats"),
    staleTime: 30_000,
  });

  const trackBytes = (cache.data ?? []).reduce((a, e) => a + e.size, 0);

  return (
    // pb gives the stat cards breathing room above the divider the
    // TabPane draws between it and the first settings row.
    <div className="grid grid-cols-3 gap-3 pb-4">
      <StatCard
        icon={MusicIcon}
        label="Cached tracks"
        value={cache.data ? String(cache.data.length) : "…"}
      />
      <StatCard
        icon={HardDriveIcon}
        label="Used by tracks"
        value={cache.data ? formatBytes(trackBytes) : "…"}
      />
      <StatCard
        icon={ImageIcon}
        label="Used by covers"
        value={covers.data ? formatBytes(covers.data.bytes) : "…"}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cache folder                                                        */
/* ------------------------------------------------------------------ */

type CacheDirInfo = {
  path: string;
  defaultPath: string;
  isCustom: boolean;
  needsRestart: boolean;
};

function CacheFolderGroup() {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ["cache-dir"],
    queryFn: () => invoke<CacheDirInfo>("get_cache_dir"),
    staleTime: 30_000,
  });

  const apply = async (path: string | null) => {
    try {
      await invoke("set_cache_dir", { path });
      await qc.invalidateQueries({ queryKey: ["cache-dir"] });
      toast.success("Cache folder updated", {
        description:
          "Existing files stay where they are; new downloads use the new folder after a restart.",
        action: { label: "Restart now", onClick: () => void relaunch() },
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const change = async () => {
    const dir = await invoke<string | null>("pick_cache_folder").catch(
      () => null,
    );
    if (!dir) return;
    await apply(dir);
  };

  return (
    <Group>
      <SettingRow
        icon={FolderIcon}
        title="Cache folder"
        description={
          info.data ? (
            <span className="break-all">
              {info.data.path}
              {info.data.needsRestart ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  · restart required
                </span>
              ) : null}
            </span>
          ) : (
            "…"
          )
        }
        control={
          <div className="flex shrink-0 items-center gap-2">
            {info.data?.isCustom ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void apply(null)}
              >
                Reset
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void change()}>
              <FolderOpenIcon />
              Change
            </Button>
          </div>
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Track cache                                                         */
/* ------------------------------------------------------------------ */

function CacheGroupGate({ loggedIn }: { loggedIn: boolean }) {
  const premium = usePremiumStore((s) => s.status);
  if (premium !== "premium") {
    return <PremiumGatedCacheGroup loggedIn={loggedIn} />;
  }
  return <CacheGroup loggedIn={loggedIn} />;
}

function PremiumGatedCacheGroup({ loggedIn }: { loggedIn: boolean }) {
  const qc = useQueryClient();
  return (
    <Group>
      <SettingRow
        icon={LockIcon}
        iconClassName="text-amber-600 dark:text-amber-400"
        title="Track caching is Premium-only"
        description={
          loggedIn
            ? "No active Premium subscription found on this account. Detection reads YT Music's account menu; if it got you wrong, re-check after a moment."
            : "Sign in with a Google account that has YouTube Premium to keep played tracks on disk."
        }
        control={
          loggedIn ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ["premium-status"] });
                toast.info("Re-checking your subscription");
              }}
            >
              Re-check
            </Button>
          ) : undefined
        }
      />
    </Group>
  );
}

type CacheEntry = {
  videoId: string;
  size: number;
  modifiedSecs: number;
  // Written to a sidecar when the track was cached (see saveTrackMeta).
  // Present for tracks cached since that landed; absent for older files,
  // which fall back to the library walk and then the raw videoId.
  title?: string;
  artist?: string;
};

type FilterMode = "all" | "library" | "other";
type SortMode = "newest" | "oldest" | "largest";

const SORT_LABELS: Record<SortMode, string> = {
  newest: "Newest",
  oldest: "Oldest",
  largest: "Largest",
};

const AUTO_CLEAN_OPTIONS: { value: CacheAutoCleanPeriod; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function AutoCleanRow({ loggedIn }: { loggedIn: boolean }) {
  const period = useSettingsStore((s) => s.cacheAutoClean);
  const setPeriod = useSettingsStore((s) => s.setCacheAutoClean);
  const lastCleanAt = useSettingsStore((s) => s.lastCacheCleanAt);

  // Mirror the sweep's own scheduling (cache-cleanup.ts): the next run
  // is due one period after the last completed sweep. Before the first
  // sweep (lastCleanAt === 0) or once that moment has already passed, the
  // 30-min background tick fires it on its next check rather than at a
  // fixed clock time, so we say "due" instead of showing a stale date.
  const description = (() => {
    if (period === "off") return undefined;
    if (!loggedIn) return "Sign in to enable automatic clean-up.";
    const nextAt = lastCleanAt + AUTO_CLEAN_PERIOD_MS[period];
    if (!lastCleanAt || nextAt <= Date.now())
      return "Next clean-up is due — runs on the next check.";
    return `Next clean-up ${formatDateTime(nextAt)}`;
  })();

  return (
    <SettingRow
      icon={CalendarClockIcon}
      title="Auto-clean tracks not in library"
      description={description}
      control={
        <SegmentedControl
          value={period}
          onChange={setPeriod}
          options={AUTO_CLEAN_OPTIONS}
          disabled={!loggedIn}
        />
      }
    />
  );
}

function CacheGroup({ loggedIn }: { loggedIn: boolean }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sort, setSort] = useState<SortMode>("newest");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Same architecture as the playlist page header: while "pinned" the
  // toolbar lives OUTSIDE the scroller (portaled into a slot above
  // it), so the rows below are clipped by the scroller's own overflow
  // — frame-perfect at any scroll speed, unlike JS-driven clip-path
  // which lags composited scrolling by a frame. The toolbar itself is
  // fully transparent and sits directly on the popup's glass, so
  // there's no background to mismatch.
  //
  // The swap is jump-free by construction: the toolbar's height leaves
  // the scroll content at the same moment the same height is inserted
  // above the scroller, so every visible row keeps its on-screen
  // position and scrollTop / maxScroll stay valid.
  const [pinned, setPinned] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const scroller = wrap?.closest<HTMLElement>(".app-scroll");
    if (!wrap || !scroller) return;
    setSlotEl(
      scroller.parentElement?.querySelector<HTMLElement>(
        "[data-settings-pinned-slot]",
      ) ?? null,
    );
    let raf = 0;
    const tick = () => {
      raf = 0;
      const wrapTop = wrap.getBoundingClientRect().top;
      const scrollerTop = scroller.getBoundingClientRect().top;
      // 1px hysteresis so fractional touchpad scroll positions at the
      // exact boundary don't flip the state every frame.
      setPinned((prev) =>
        prev ? wrapTop <= scrollerTop + 1 : wrapTop <= scrollerTop,
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    tick();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const cache = useQuery({
    queryKey: ["cache-list"],
    queryFn: () => invoke<CacheEntry[]>("list_cache"),
    // Disk state changes outside React's knowledge while streams download —
    // re-fetch every 5s so the list reflects new cache entries.
    refetchInterval: 5_000,
  });

  // Everything the library pins (liked songs + playlists + albums) —
  // walking it costs a burst of InnerTube calls, so cache generously.
  const library = useQuery({
    queryKey: ["library-tracks"],
    queryFn: () => fetchLibraryTracks(),
    enabled: loggedIn,
    staleTime: 30 * 60_000,
    retry: false,
  });

  const libraryMeta = useMemo(() => {
    const m = new Map<string, ShelfItem>();
    for (const t of library.data ?? []) m.set(t.id, t);
    return m;
  }, [library.data]);

  // Titles and "in library" status BOTH come from the library walk, and
  // it costs a burst of InnerTube round-trips. Until it lands, libraryMeta
  // is empty — every row would otherwise show its raw videoId as the title
  // and count as "not in library". Track that window so the UI can render a
  // pending state instead of presenting the empty result as authoritative.
  // `isLoading` is true only for the first in-flight fetch (false when
  // disabled/logged-out, resolved, or errored), which is exactly the
  // window we want to mask.
  const libraryLoading = library.isLoading;

  const filtered = useMemo(() => {
    let list = cache.data ?? [];
    if (filter === "library")
      list = list.filter((e) => libraryMeta.has(e.videoId));
    else if (filter === "other")
      list = list.filter((e) => !libraryMeta.has(e.videoId));
    const sorted = [...list].sort((a, b) => {
      if (sort === "newest") return b.modifiedSecs - a.modifiedSecs;
      if (sort === "oldest") return a.modifiedSecs - b.modifiedSecs;
      return b.size - a.size;
    });
    return sorted;
  }, [cache.data, filter, sort, libraryMeta]);

  const totalBytes = (cache.data ?? []).reduce((a, e) => a + e.size, 0);
  const inLibraryCount = (cache.data ?? []).filter((e) =>
    libraryMeta.has(e.videoId),
  ).length;
  const otherCount = (cache.data ?? []).length - inLibraryCount;

  const deleteEntries = async (ids: string[], label: string) => {
    try {
      const freed = await invoke<number>("delete_cache_entries", {
        videoIds: ids,
      });
      await qc.invalidateQueries({ queryKey: ["cache-list"] });
      // Drop the in-memory prefetch log: anything we'd previously marked as
      // "warm" might now be gone from disk and should be re-prefetchable.
      clearPrefetchMemo();
      toast.success(`${label} — freed ${formatBytes(freed)}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const deleteOne = async (id: string) => {
    setPending((p) => new Set(p).add(id));
    await deleteEntries([id], "Removed");
    setPending((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  };

  const clearAll = async () => {
    if (!cache.data?.length) return;
    if (
      !confirm(
        `Delete all ${cache.data.length} cached tracks (${formatBytes(
          totalBytes,
        )})? Tracks from your library will be removed too.`,
      )
    )
      return;
    setBulkBusy(true);
    await deleteEntries([], "Cleared cache");
    setBulkBusy(false);
  };

  const clearOthers = async () => {
    const ids = (cache.data ?? [])
      .filter((e) => !libraryMeta.has(e.videoId))
      .map((e) => e.videoId);
    if (!ids.length) {
      toast.info("Nothing to clear — everything cached is in your library.");
      return;
    }
    if (
      !confirm(
        `Delete ${ids.length} cached tracks that aren't in your library?`,
      )
    )
      return;
    setBulkBusy(true);
    await deleteEntries(ids, "Cleared non-library tracks");
    setBulkBusy(false);
  };

  // Rendered either in flow (at rest) or through the portal into the
  // pinned slot — a single JSX tree so both spots share the same
  // controls and state.
  const headerToolbar = (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <DatabaseIcon className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-[15px] font-medium leading-none">
            Cached tracks
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={clearAll}
            disabled={bulkBusy || !cache.data?.length}
            className="border-destructive/50 text-destructive hover:border-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50 dark:hover:bg-destructive/10"
          >
            Clear All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clearOthers}
            // Also gated on the library set having actually loaded —
            // before that, EVERY cached track counts as "other" and one
            // click would nuke the lot.
            disabled={bulkBusy || !library.data || otherCount === 0}
          >
            {bulkBusy ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <Trash2Icon />
            )}
            Clear Others
          </Button>
        </div>
      </div>
      {/* Filter toggle + sort share the second row. The toggle
              flex-grows; without a login there's no toggle, so a spacer
              keeps the sort control right-aligned. */}
      <div className="flex items-center gap-2">
        {loggedIn ? (
          <div className="min-w-0 flex-1">
            <SegmentedControl
              fullWidth
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${cache.data?.length ?? 0})` },
                {
                  value: "library",
                  label: libraryLoading ? (
                    <span className="inline-flex items-center gap-1.5">
                      In library
                      <Loader2Icon className="size-3 animate-spin" />
                    </span>
                  ) : (
                    `In library (${inLibraryCount})`
                  ),
                },
                {
                  value: "other",
                  label: libraryLoading ? (
                    <span className="inline-flex items-center gap-1.5">
                      Other
                      <Loader2Icon className="size-3 animate-spin" />
                    </span>
                  ) : (
                    `Other (${otherCount})`
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <ArrowDownWideNarrowIcon />
              {SORT_LABELS[sort]}
              <ChevronDownIcon className="opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(v) => setSort(v as SortMode)}
            >
              <DropdownMenuRadioItem value="newest">
                Newest first
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="oldest">
                Oldest first
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="largest">
                Largest first
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <Group>
      {/* Toolbar + list share one wrapper so Group's divider doesn't
          draw a line between them. While pinned, the toolbar teleports
          into the pane's slot above the scroller (see the effect
          above) — rows are then clipped by the scroller's own
          overflow, so the transparent toolbar needs no background. */}
      {pinned && slotEl ? createPortal(headerToolbar, slotEl) : null}
      <div ref={wrapRef}>
        {pinned ? null : headerToolbar}
        <div className="flex flex-col divide-y divide-border/50">
          {cache.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {cache.isError
                ? "Couldn't read the cache folder."
                : cache.data?.length === 0
                  ? "Cache is empty — tracks land here as you play them."
                  : "No tracks match this filter."}
            </div>
          ) : (
            filtered.map((entry) => (
              <CacheRow
                key={entry.videoId}
                entry={entry}
                meta={libraryMeta.get(entry.videoId)}
                inLibrary={libraryMeta.has(entry.videoId)}
                libraryLoading={libraryLoading}
                isDeleting={pending.has(entry.videoId)}
                onDelete={() => deleteOne(entry.videoId)}
              />
            ))
          )}
        </div>
      </div>
    </Group>
  );
}

function CacheRow({
  entry,
  meta,
  inLibrary,
  libraryLoading,
  isDeleting,
  onDelete,
}: {
  entry: CacheEntry;
  meta: ShelfItem | undefined;
  inLibrary: boolean;
  libraryLoading: boolean;
  isDeleting: boolean;
  onDelete: () => void;
}) {
  // YouTube publishes thumbnails for every videoId on a public CDN, so we
  // can render one without needing a real API round-trip just to draw
  // this row.
  const thumb = `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`;
  // Prefer the library walk (freshest, structured), then the on-disk
  // sidecar written when the track was cached, then the raw videoId.
  const title = meta?.title ?? entry.title ?? entry.videoId;
  const subtitle =
    meta?.artists?.map((a) => a.name).join(", ") ||
    meta?.subtitle ||
    entry.artist ||
    "";
  // The in-library badge depends on the library walk, but the title no
  // longer does when a sidecar exists. Only skeleton the title while the
  // walk is in flight AND we have no title from either source yet — that's
  // the one case where a name might still appear. The timestamp below is
  // derived from cache metadata we already have, so it stays visible
  // throughout.
  const resolving = libraryLoading && !meta && !entry.title;

  return (
    <div
      className={cn(
        // No hover — the row isn't clickable (only the trash button
        // is). No rounding either: rounded corners made the divide-y
        // hairline between rows curl up at its ends.
        "flex items-center gap-3 py-2",
        isDeleting && "opacity-50",
      )}
    >
      <div className="relative size-10 shrink-0">
        <img
          src={thumb}
          alt=""
          loading="lazy"
          className="size-full rounded-sm bg-muted object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        {/* Hairline outline, same treatment as the main track lists —
            a white border knocked back to 10% via mix-blend-difference
            so it reads on both light and dark covers. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-sm border border-white opacity-10 mix-blend-difference"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-5 items-center gap-2">
          {resolving ? (
            <Skeleton className="h-3.5 w-40 max-w-full rounded-xs" />
          ) : (
            <>
              <span className="truncate text-sm font-medium">{title}</span>
              {inLibrary && (
                <Badge
                  variant="secondary"
                  title="In library"
                  aria-label="In library"
                  // Icon-only chip; px-1 tightens the now text-less pill so
                  // it isn't mostly padding. Meaning is carried by the
                  // title/aria-label instead of a visible caption.
                  className="bg-emerald-500/15 px-1 text-emerald-600 dark:text-emerald-400"
                >
                  <LibraryIcon className="size-3" />
                </Badge>
              )}
            </>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {subtitle ? `${subtitle} · ` : ""}
          {formatRelative(entry.modifiedSecs)}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatBytes(entry.size)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        disabled={isDeleting}
        aria-label="Delete cached track"
        className="text-muted-foreground hover:text-destructive"
      >
        {isDeleting ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <Trash2Icon className="size-4" />
        )}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cover cache                                                         */
/* ------------------------------------------------------------------ */

function CoverCacheGroup() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const stats = useQuery({
    queryKey: ["cover-cache-stats"],
    queryFn: () =>
      invoke<{ count: number; bytes: number }>("cover_cache_stats"),
    staleTime: 30_000,
  });

  const clear = async () => {
    if (!stats.data?.count) return;
    if (
      !confirm(
        `Delete ${stats.data.count} cached cover image${
          stats.data.count === 1 ? "" : "s"
        } (${formatBytes(stats.data.bytes)})?`,
      )
    )
      return;
    setBusy(true);
    try {
      const freed = await invoke<number>("clear_cover_cache");
      await qc.invalidateQueries({ queryKey: ["cover-cache-stats"] });
      toast.success(`Cover cache cleared — freed ${formatBytes(freed)}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group>
      <SettingRow
        icon={ImageIcon}
        title="Cover art cache"
        control={
          // Counts live in the stat cards up top — the row keeps just
          // the action.
          <Button
            variant="outline"
            size="sm"
            onClick={clear}
            disabled={busy || !stats.data?.count}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
            Clear
          </Button>
        }
      />
    </Group>
  );
}
