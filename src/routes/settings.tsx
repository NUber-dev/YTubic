import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2Icon,
  UserRoundIcon,
  LogInIcon,
  LogOutIcon,
  Loader2Icon,
  DatabaseIcon,
  Trash2Icon,
  HeartIcon,
  ImageIcon,
  LockIcon,
  CookieIcon,
  UploadIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resetInnertube } from "@/lib/innertube/client";
import { fetchLikedSongs } from "@/lib/innertube/library";
import { clearPrefetchMemo } from "@/lib/stream";
import { usePremiumStore } from "@/lib/store/premium";
import { removeAccount } from "@/lib/store/accounts";
import type { ShelfItem } from "@/lib/innertube/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [signingIn, setSigningIn] = useState(false);
  const [importing, setImporting] = useState(false);
  const [cookieText, setCookieText] = useState("");
  const [loginReady, setLoginReady] = useState(false);

  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  useEffect(() => {
    // Settings owns the in-flight spinner + the toast feedback for
    // sign-in from this page. Query invalidation + InnerTube client
    // reset live in the global `useLoginSuccessListener` so they fire
    // regardless of where the sign-in was initiated (here or from the
    // sidebar dropdown).
    const unlistenSuccess = listen("login-success", () => {
      setSigningIn(false);
      setLoginReady(false);
      toast.success("Signed in");
    });
    const unlistenCancel = listen("login-cancelled", () => {
      setSigningIn(false);
      setLoginReady(false);
    });
    const unlistenFailed = listen<string>("login-failed", (event) => {
      setSigningIn(false);
      setLoginReady(false);
      toast.error(event.payload, { duration: 14_000 });
    });
    const unlistenReady = listen("login-ready", () => {
      setLoginReady(true);
    });
    const unlistenInsecure = listen("login-insecure-browser", () => {
      toast.error(
        "Google blocked sign-in in this window. Use Import session from browser below instead.",
        { duration: 12_000 },
      );
    });
    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
      unlistenFailed.then((fn) => fn());
      unlistenReady.then((fn) => fn());
      unlistenInsecure.then((fn) => fn());
    };
  }, []);

  const confirmLogin = async () => {
    try {
      await invoke("confirm_login");
      toast.message("Finishing sign-in…", {
        description: "Stay on music.youtube.com in the login window.",
      });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const cancelLogin = async () => {
    try {
      await invoke("cancel_login");
    } catch {
      /* window may already be closed */
    }
    setSigningIn(false);
    setLoginReady(false);
  };

  const importCookies = async () => {
    if (!cookieText.trim()) {
      toast.error("Paste Netscape-format cookies first");
      return;
    }
    setImporting(true);
    try {
      await invoke("import_cookies_from_text", { text: cookieText });
      setCookieText("");
      toast.success("Session imported");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setImporting(false);
    }
  };

  const importCookiesFromFile = async () => {
    setImporting(true);
    try {
      await invoke("import_cookies_from_file");
      toast.success("Session imported from file");
    } catch (e) {
      if (!String(e).includes("no file selected")) {
        toast.error(String(e));
      }
    } finally {
      setImporting(false);
    }
  };

  const signIn = async () => {
    setSigningIn(true);
    try {
      await invoke("start_login");
    } catch (e) {
      setSigningIn(false);
      toast.error(String(e));
    }
  };

  const logout = async () => {
    try {
      // Per-account sign out: only the currently active account is
      // removed. If the user has other accounts registered, Rust's
      // `remove_account` promotes the next one to active; otherwise we
      // end up signed out entirely. Either way `accounts-changed`
      // fires and the global listener handles the cache reset.
      const activeId = await invoke<string | null>("get_active_account_id");
      if (activeId) {
        await removeAccount(activeId);
      } else {
        // Defensive fallback — no active account but the button was
        // somehow clickable. Nuke everything to leave a clean state.
        await invoke("clear_cookies");
        resetInnertube();
      }
      toast.success("Signed out");
    } catch (e) {
      toast.error(`Logout failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="flex items-center gap-2">
                <UserRoundIcon className="size-5" />
                Account
              </CardTitle>
              <CardDescription>
                Sign in with your Google account to see your library, liked
                songs, and play Premium-quality streams. Cookies stay on
                this machine.
              </CardDescription>
            </div>
            {loggedIn.data ? (
              <Badge
                variant="secondary"
                className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2Icon className="size-3.5" />
                Signed in
              </Badge>
            ) : (
              <Badge variant="outline">Signed out</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loggedIn.data ? (
            <Button variant="outline" onClick={logout}>
              <LogOutIcon />
              Sign out
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <Button onClick={signIn} disabled={signingIn}>
                {signingIn ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <LogInIcon />
                )}
                Sign in with Google
              </Button>
              {loginReady ? (
                <div className="flex flex-col gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  <p>
                    In the login window, go to <strong>music.youtube.com</strong>{" "}
                    and make sure you are signed in, then click Continue. YTubic
                    will save your session and close the window.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void confirmLogin()}
                    >
                      Continue
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void cancelLogin()}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : signingIn ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void cancelLogin()}
                >
                  Cancel sign-in
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <CookieIcon className="size-5" />
              Import session from browser
            </CardTitle>
            <CardDescription>
              If Google blocks the embedded sign-in window, export cookies from
              Chrome or Edge where you are already signed in to YouTube Music.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground">
            <p className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              Security warning
            </p>
            <p className="mt-1">
              Pasted cookies are full account credentials. They stay encrypted
              on this PC only — never share them or paste them into untrusted
              sites.
            </p>
          </div>

          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">How to export</p>
            <ol className="mt-2 list-decimal space-y-1 ps-5">
              <li>
                In Chrome or Edge, sign in at{" "}
                <a
                  href="https://music.youtube.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  music.youtube.com
                </a>
              </li>
              <li>
                Use a Netscape cookie exporter extension (e.g. &quot;Get
                cookies.txt LOCALLY&quot;) for <code>youtube.com</code> and{" "}
                <code>google.com</code>
              </li>
              <li>Paste the file contents below or choose the exported file</li>
            </ol>
            <p className="mt-2">
              Required: export cookies for both <code>youtube.com</code> and{" "}
              <code>google.com</code> (e.g. <code>SAPISID</code>,{" "}
              <code>__Secure-1PSID</code>, <code>LOGIN_INFO</code>).
            </p>
          </div>

          <textarea
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t..."}
            rows={8}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            spellCheck={false}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void importCookies()}
              disabled={importing || !cookieText.trim()}
            >
              {importing ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <CookieIcon />
              )}
              Import pasted cookies
            </Button>
            <Button
              variant="outline"
              onClick={() => void importCookiesFromFile()}
              disabled={importing}
            >
              {importing ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <UploadIcon />
              )}
              Choose file…
            </Button>
          </div>
        </CardContent>
      </Card>

      <CacheCardGate loggedIn={!!loggedIn.data} />

      <CoverCacheCard />
    </div>
  );
}

function PremiumGatedCacheCard({ loggedIn }: { loggedIn: boolean }) {
  const setOverride = usePremiumStore((s) => s.setOverride);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <DatabaseIcon className="size-5" />
              Cache
            </CardTitle>
            <CardDescription>
              Persistent track caching is a YouTube Premium feature.
              {loggedIn
                ? " We didn't find an active Premium subscription on this account, so streams play through without being saved to disk."
                : " Sign in with a Google account that has YouTube Premium to enable on-disk caching."}
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          >
            <LockIcon className="size-3.5" />
            Premium only
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          While caching is disabled, YTubic still plays your music — it
          just doesn't keep a local copy after the session. Playback also
          honors the ads and audio-quality tier of your YouTube Music
          account, the same way the official web player does.
        </p>
        {loggedIn ? (
          <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
            <p className="text-sm">
              <span className="font-medium">Already on Premium?</span> Our
              detection reads YouTube Music's account menu, which doesn't
              always include a clear membership badge. If you're sure your
              subscription is active, enable caching manually.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setOverride(true);
                toast.success("Caching enabled");
              }}
            >
              I have Premium — enable caching
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CacheCardGate({ loggedIn }: { loggedIn: boolean }) {
  const premium = usePremiumStore((s) => s.status);
  const override = usePremiumStore((s) => s.override);
  if (premium !== "premium" && !override) {
    return <PremiumGatedCacheCard loggedIn={loggedIn} />;
  }
  return <CacheCard loggedIn={loggedIn} overridden={override && premium !== "premium"} />;
}

function CoverCacheCard() {
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

  const empty = !stats.data?.count;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <ImageIcon className="size-5" />
              Cover art cache
            </CardTitle>
            <CardDescription>
              Album covers (iTunes hi-res lookups and YouTube originals)
              are pinned to disk so they don't redownload on every play.
            </CardDescription>
          </div>
          <Badge variant="outline">
            {stats.isLoading
              ? "…"
              : `${stats.data?.count ?? 0} files · ${formatBytes(
                  stats.data?.bytes ?? 0,
                )}`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={clear}
          disabled={busy || empty}
        >
          {busy ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <Trash2Icon />
          )}
          Clear cover cache
        </Button>
      </CardContent>
    </Card>
  );
}

type CacheEntry = {
  videoId: string;
  size: number;
  modifiedSecs: number;
};

type FilterMode = "all" | "liked" | "notLiked";
type SortMode = "newest" | "oldest" | "largest";

function CacheCard({
  loggedIn,
  overridden,
}: {
  loggedIn: boolean;
  overridden: boolean;
}) {
  const qc = useQueryClient();
  const setOverride = usePremiumStore((s) => s.setOverride);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sort, setSort] = useState<SortMode>("newest");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const cache = useQuery({
    queryKey: ["cache-list"],
    queryFn: () => invoke<CacheEntry[]>("list_cache"),
    // Disk state changes outside React's knowledge while streams download —
    // re-fetch every 5s so the list reflects new cache entries.
    refetchInterval: 5_000,
  });

  const liked = useQuery({
    queryKey: ["liked-songs"],
    queryFn: () => fetchLikedSongs(),
    enabled: loggedIn,
    staleTime: 60_000,
    retry: false,
  });

  const likedMeta = useMemo(() => {
    const m = new Map<string, ShelfItem>();
    for (const t of liked.data ?? []) m.set(t.id, t);
    return m;
  }, [liked.data]);

  const filtered = useMemo(() => {
    let list = cache.data ?? [];
    if (filter === "liked") list = list.filter((e) => likedMeta.has(e.videoId));
    else if (filter === "notLiked")
      list = list.filter((e) => !likedMeta.has(e.videoId));
    const sorted = [...list].sort((a, b) => {
      if (sort === "newest") return b.modifiedSecs - a.modifiedSecs;
      if (sort === "oldest") return a.modifiedSecs - b.modifiedSecs;
      return b.size - a.size;
    });
    return sorted;
  }, [cache.data, filter, sort, likedMeta]);

  const totalBytes = (cache.data ?? []).reduce((a, e) => a + e.size, 0);
  const likedInCache = (cache.data ?? []).filter((e) =>
    likedMeta.has(e.videoId),
  ).length;
  const notLikedInCache = (cache.data ?? []).length - likedInCache;

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
        )})? Liked songs will be removed too.`,
      )
    )
      return;
    setBulkBusy(true);
    await deleteEntries([], "Cleared cache");
    setBulkBusy(false);
  };

  const clearNotLiked = async () => {
    const ids = (cache.data ?? [])
      .filter((e) => !likedMeta.has(e.videoId))
      .map((e) => e.videoId);
    if (!ids.length) {
      toast.info("Nothing to clear — everything cached is liked.");
      return;
    }
    if (!confirm(`Delete ${ids.length} non-liked tracks?`)) return;
    setBulkBusy(true);
    await deleteEntries(ids, "Cleared non-liked");
    setBulkBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <DatabaseIcon className="size-5" />
              Cache
            </CardTitle>
            <CardDescription>
              Tracks you've played stay on disk so they're instant on replay.
              {loggedIn
                ? " Liked songs are labelled so you can clear only the noise."
                : " Sign in above to show which cached tracks are in your liked songs."}
            </CardDescription>
          </div>
          <Badge variant="outline">
            {cache.data?.length ?? 0} tracks · {formatBytes(totalBytes)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {overridden ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <span className="text-muted-foreground">
              Caching is enabled via manual Premium override. Turn it off if
              this account isn't actually on Premium.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOverride(false);
                toast.info("Manual Premium override turned off");
              }}
            >
              Turn off override
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label={`All (${cache.data?.length ?? 0})`}
          />
          <FilterChip
            active={filter === "liked"}
            onClick={() => setFilter("liked")}
            label={`Liked (${likedInCache})`}
            disabled={!loggedIn}
          />
          <FilterChip
            active={filter === "notLiked"}
            onClick={() => setFilter("notLiked")}
            label={`Not liked (${notLikedInCache})`}
            disabled={!loggedIn}
          />
          <div className="ms-auto flex items-center gap-2">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest first</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={clearNotLiked}
              disabled={bulkBusy || !loggedIn || notLikedInCache === 0}
            >
              Clear non-liked
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={clearAll}
              disabled={bulkBusy || !cache.data?.length}
            >
              {bulkBusy ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <Trash2Icon />
              )}
              Clear all
            </Button>
          </div>
        </div>

        <div className="flex flex-col divide-y divide-border rounded-md border max-h-[480px] overflow-y-auto">
          {cache.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {cache.data?.length === 0
                ? "Cache is empty — tracks land here as you play them."
                : "No tracks match this filter."}
            </div>
          ) : (
            filtered.map((entry) => (
              <CacheRow
                key={entry.videoId}
                entry={entry}
                meta={likedMeta.get(entry.videoId)}
                isLiked={likedMeta.has(entry.videoId)}
                isDeleting={pending.has(entry.videoId)}
                onDelete={() => deleteOne(entry.videoId)}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

function CacheRow({
  entry,
  meta,
  isLiked,
  isDeleting,
  onDelete,
}: {
  entry: CacheEntry;
  meta: ShelfItem | undefined;
  isLiked: boolean;
  isDeleting: boolean;
  onDelete: () => void;
}) {
  // YouTube publishes thumbnails for every videoId on a public CDN, so we
  // can render one without needing a real API round-trip just to draw
  // this row.
  const thumb = `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`;
  const title = meta?.title ?? entry.videoId;
  const subtitle =
    meta?.artists?.map((a) => a.name).join(", ") ||
    meta?.subtitle ||
    "";

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2",
        isDeleting && "opacity-50",
      )}
    >
      <img
        src={thumb}
        alt=""
        loading="lazy"
        className="h-10 w-14 shrink-0 rounded object-cover bg-muted"
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {isLiked && (
            <Badge
              variant="secondary"
              className="gap-1 bg-rose-500/15 text-rose-600 dark:text-rose-400"
            >
              <HeartIcon className="size-3 fill-current" />
              Liked
            </Badge>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {subtitle ? `${subtitle} · ` : ""}
          {formatBytes(entry.size)} ·{" "}
          {formatRelative(entry.modifiedSecs)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        disabled={isDeleting}
        aria-label="Delete cached track"
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatRelative(unixSecs: number): string {
  if (!unixSecs) return "";
  const diff = Math.max(0, Date.now() / 1000 - unixSecs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSecs * 1000);
  return d.toLocaleDateString();
}
