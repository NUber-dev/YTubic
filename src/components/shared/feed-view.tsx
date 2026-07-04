import { useEffect, useRef, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { ShelfGrid } from "@/components/shared/shelf-grid";
import { Skeleton } from "@/components/ui/skeleton";
import type { Shelf } from "@/lib/innertube/types";

export type FeedPage = {
  shelves: Shelf[];
  nextCursor?: string;
};

type Props = {
  title: string;
  /** Stable react-query key prefix; combined internally with the cursor. */
  queryKey: readonly unknown[];
  fetcher: (cursor?: string) => Promise<FeedPage>;
  /** Optional intro slot (hero tiles, category chips, etc). */
  header?: ReactNode;
  errorLabel?: string;
};

// Shared shell for the Explore family of feeds (Explore / Charts /
// New releases / Moods & genres). Same shape as Home but kept separate
// because Home has its own page-scoped layout we don't want to disturb.
export function FeedView({
  title,
  queryKey,
  fetcher,
  header,
  errorLabel = "Couldn't load feed",
}: Props) {
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
    queryKey,
    queryFn: ({ pageParam }) => fetcher(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const shelves = data?.pages.flatMap((p) => p.shelves) ?? [];

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {isFetching && !isLoading && !isFetchingNextPage ? (
          <span className="text-xs text-muted-foreground">Updating…</span>
        ) : null}
      </div>

      {header}

      {error ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">{errorLabel}</span>
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

      {isLoading ? <FeedSkeleton /> : null}

      {shelves.map((shelf) =>
        shelf.display === "grid" ? (
          <ShelfGrid key={shelf.id} shelf={shelf} />
        ) : (
          <ShelfCarousel key={shelf.id} shelf={shelf} />
        ),
      )}

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
  );
}

function FeedSkeleton() {
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
