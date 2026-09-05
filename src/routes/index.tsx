import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchHomeFeedPage } from "@/lib/innertube/home";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { HomeConfigureDialog } from "@/components/shared/home-configure-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { arrangeTitles, useHomeSectionsStore } from "@/lib/store/home-sections";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

const HOME_KEY = ["home", "v2"];

/** The pinned title row: 12px above, a 36px button row, 20px below. */
const HEADER_HEIGHT = 68;
/**
 * Where the scroller's fade ends. The fade is 32px tall, so it starts
 * 8px under the button row rather than against it, and the content
 * begins right where it ends, so nothing is faded at rest.
 */
const FADE_EDGE = HEADER_HEIGHT + 20;

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: HOME_KEY,
    queryFn: ({ pageParam }) => fetchHomeFeedPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const loaded = data?.pages.flatMap((p) => p.shelves) ?? [];

  // The user's arrangement: their order first, then anything new the
  // feed sent, minus what they switched off. Title is the identity
  // (see home-sections.ts), so two same-titled shelves keep their
  // relative feed order under one slot.
  const order = useHomeSectionsStore((s) => s.order);
  const hidden = useHomeSectionsStore((s) => s.hidden);
  const noteSeen = useHomeSectionsStore((s) => s.noteSeen);
  // Keyed on the joined titles so a re-render with the same feed does
  // not re-stamp the store.
  const loadedTitles = loaded.map((s) => s.title);
  const loadedKey = loadedTitles.join("\u0000");
  useEffect(() => {
    if (loadedTitles.length > 0) noteSeen(loadedTitles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, noteSeen]);
  const titles = arrangeTitles(loadedTitles, order);
  const rank = new Map(titles.map((t, i) => [t, i]));
  const shelves = loaded
    .filter((s) => !hidden.includes(s.title))
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        (rank.get(a.s.title) ?? 0) - (rank.get(b.s.title) ?? 0) || a.i - b.i,
    )
    .map(({ s }) => s);

  const [configuring, setConfiguring] = useState(false);
  const queryClient = useQueryClient();
  // A fresh first page rather than a refetch of every loaded page: the
  // feed reshuffles on each visit, and that reshuffle is the point of
  // the button.
  const refresh = () => queryClient.resetQueries({ queryKey: HOME_KEY });

  // The title row lives outside the scroller, in the shell's header
  // slot, and the scroller's top edge is masked so content dissolves
  // under it as it scrolls past. No per-frame work: the mask is fixed
  // to the scroller's box, and the header never moves. A painted
  // header background would not do: the ambient backdrop is fixed
  // behind everything, so an opaque band would sit visibly on it.
  const pageRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // Layout effect: the slot is found before first paint, so the header
  // never renders in flow, not even for a frame.
  useLayoutEffect(() => {
    const scroller = pageRef.current?.closest("main");
    if (!scroller) return;
    setSlot(
      scroller.parentElement?.querySelector<HTMLElement>(
        "[data-route-header-slot]",
      ) ?? null,
    );
    scroller.classList.add("route-header-fade");
    scroller.style.setProperty("--route-header-fade", `${FADE_EDGE}px`);
    return () => {
      scroller.classList.remove("route-header-fade");
      scroller.style.removeProperty("--route-header-fade");
    };
  }, []);

  const header = (
    <div
      className="flex items-center justify-between gap-4 px-6 pb-5 pt-3"
      style={{ height: HEADER_HEIGHT }}
    >
      <h1 className="text-3xl font-bold tracking-tight">Home</h1>
      <div className="flex items-center gap-2">
        {isFetching && !isLoading && !isFetchingNextPage ? (
          <span className="mr-1 text-xs text-muted-foreground">Updating…</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={refresh}
              disabled={isFetching}
              aria-label="Refresh"
            >
              <RefreshCwIcon
                className={cn("size-4", isFetching && "animate-spin")}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setConfiguring(true)}
              aria-label="Configure sections"
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Configure sections</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    // `error` guard: stop auto-loading after a failed continuation so the
    // still-visible sentinel doesn't re-fire fetchNextPage in a loop.
    if (!node || !hasNextPage || isFetchingNextPage || error) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, error]);

  return (
    <div
      ref={pageRef}
      className="flex flex-col px-6 pb-6"
      style={{ paddingTop: FADE_EDGE - 12 }}
    >
      {slot ? createPortal(header, slot) : null}
      <HomeConfigureDialog
        open={configuring}
        onOpenChange={setConfiguring}
        titles={loadedTitles}
      />

      <div className="flex flex-col gap-8 pt-3">
        {error ? (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
            <div className="flex flex-col gap-1">
              <span className="font-medium">Couldn't load home feed</span>
              <span className="text-muted-foreground">
                {(error as Error).message}
              </span>
              <button
                type="button"
                onClick={() => refetch()}
                className="mt-1 w-fit text-brand hover:underline"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {isLoading ? <HomeSkeleton /> : null}

        {shelves.map((shelf) => (
          <ShelfCarousel key={shelf.id} shelf={shelf} />
        ))}

        {hasNextPage ? (
          <div
            ref={sentinelRef}
            className="flex h-16 items-center justify-center text-muted-foreground"
          >
            {isFetchingNextPage ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: 3 }).map((_, shelfIdx) => (
        <section key={shelfIdx} className="flex flex-col gap-3">
          <Skeleton className="h-6 w-64" />
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
