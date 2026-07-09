import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, Loader2Icon, LogInIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShelfCard } from "@/components/shared/shelf-card";
import { TrackList } from "@/components/shared/track-list";
import {
  fetchLibraryAlbums,
  fetchLibraryArtists,
  fetchLibraryPlaylists,
  type LibrarySection,
} from "@/lib/innertube/library";
import {
  fetchPlaylistContinuation,
  fetchPlaylistFirstPage,
  type PlaylistFirstPage,
  type PlaylistNextPage,
} from "@/lib/innertube/playlist";
import { openSettings } from "@/lib/store/settings-dialog";

export const Route = createFileRoute("/library")({
  component: LibraryPage,
});

function LibraryPage() {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  const [tab, setTab] = useState("playlists");

  if (loggedIn.data === false) {
    return <LoggedOutState />;
  }

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <h1 className="text-3xl font-bold tracking-tight">Library</h1>
      <AnimatedTabs
        activeTab={tab}
        onChange={setTab}
        tabs={[
          { id: "playlists", label: "Playlists" },
          { id: "songs", label: "Songs" },
          { id: "albums", label: "Albums" },
          { id: "artists", label: "Artists" },
        ]}
      />
      <div className="pt-2">
        {tab === "playlists" && (
          <SectionsView
            queryKey={["library", "playlists"]}
            fetcher={fetchLibraryPlaylists}
          />
        )}
        {tab === "songs" && <LikedSongsView />}
        {tab === "albums" && (
          <SectionsView
            queryKey={["library", "albums"]}
            fetcher={fetchLibraryAlbums}
          />
        )}
        {tab === "artists" && (
          <SectionsView
            queryKey={["library", "artists"]}
            fetcher={fetchLibraryArtists}
          />
        )}
      </div>
    </div>
  );
}

function LoggedOutState() {
  return (
    <div className="flex flex-col items-center gap-4 p-12 text-center">
      <LogInIcon className="size-12 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Sign in to see your library</h2>
        <p className="text-sm text-muted-foreground">
          Import your YouTube Music session from a browser to unlock liked
          songs, playlists, and premium-quality streams.
        </p>
      </div>
      <Button onClick={() => openSettings("general")}>Go to Settings</Button>
    </div>
  );
}

function SectionsView({
  queryKey,
  fetcher,
}: {
  queryKey: readonly string[];
  fetcher: () => Promise<LibrarySection[]>;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: fetcher,
  });

  if (error) return <ErrorCard message={(error as Error).message} />;
  if (isLoading) return <SectionsSkeleton />;
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing here yet.</p>;
  }

  // Flatten all sections into a single grid. Library shelves come back with
  // auto-generated "Section N" titles from the parser fallback, so a flat
  // grid reads cleaner than multiple titled rows.
  const items = data.flatMap((s) => s.items);

  return (
    <div className="grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] [&>*]:max-w-[20rem]">
      {items.map((item) => (
        <ShelfCard key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

type AnyPage = PlaylistFirstPage | PlaylistNextPage;

function LikedSongsView() {
  const query = useInfiniteQuery<AnyPage, Error>({
    queryKey: ["library", "liked-songs-pages"],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      if (!pageParam) return fetchPlaylistFirstPage("LM");
      return fetchPlaylistContinuation(pageParam as string);
    },
    getNextPageParam: (lastPage) => lastPage.continuationToken,
  });

  const pages = query.data?.pages ?? [];
  const tracks = useMemo(() => pages.flatMap((p) => p.tracks), [pages]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!query.hasNextPage) return;
    // Stop auto-loading once a continuation errored (avoids an unbounded
    // retry loop while the sentinel stays visible).
    if (query.error) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !query.isFetchingNextPage) {
            query.fetchNextPage();
          }
        }
      },
      { rootMargin: "600px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, query.error]);

  // Only show the full error card before any tracks load; a failed
  // continuation must not wipe the already-loaded liked-songs list.
  if (query.error && tracks.length === 0)
    return <ErrorCard message={query.error.message} />;
  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (tracks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No liked songs yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <TrackList tracks={tracks} />
      {query.hasNextPage && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-6 text-sm text-muted-foreground"
        >
          {query.isFetchingNextPage ? (
            <>
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              Loading more…
            </>
          ) : (
            <span className="sr-only">Scroll to load more</span>
          )}
        </div>
      )}
    </div>
  );
}

function SectionsSkeleton() {
  return (
    <div className="grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] [&>*]:max-w-[20rem]">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 p-2">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
      <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
      <div className="flex flex-col gap-1">
        <span className="font-medium">Couldn't load library</span>
        <span className="text-muted-foreground">{message}</span>
      </div>
    </div>
  );
}
