import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { fetchArtist } from "@/lib/innertube/artist";
import { EntityHeader } from "@/components/shared/entity-header";
import { ShelfCarousel } from "@/components/shared/shelf-carousel";
import { TrackList } from "@/components/shared/track-list";
import { Skeleton } from "@/components/ui/skeleton";
import type { Shelf } from "@/lib/innertube/types";

export const Route = createFileRoute("/artist/$id")({
  component: ArtistPageView,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      queryKey: ["artist", params.id],
      queryFn: () => fetchArtist(params.id),
    }),
});

function ArtistPageView() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["artist", id],
    queryFn: () => fetchArtist(id),
  });

  if (error) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">Couldn't load artist</span>
          <span className="text-muted-foreground">
            {(error as Error).message}
          </span>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <ArtistSkeleton />;

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader
        title={data.name}
        subtitle={data.subscribers}
        description={data.description}
        thumbnails={data.thumbnails}
        round
      />

      {data.shelves.map((shelf) =>
        shelf.display === "list" ? (
          <ListShelf key={shelf.id} shelf={shelf} />
        ) : (
          <ShelfCarousel key={shelf.id} shelf={shelf} />
        ),
      )}
    </div>
  );
}

function ListShelf({ shelf }: { shelf: Shelf }) {
  const tracks = shelf.items.filter((i) => i.kind === "song");
  if (tracks.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="truncate px-1 text-xl font-semibold tracking-tight">
        {shelf.title}
      </h2>
      {/* Artist top-songs shelf doesn't carry duration in the YT
          payload, but does ship a play count — swap the columns. */}
      <TrackList tracks={tracks} showPlays />
    </section>
  );
}

function ArtistSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <div className="flex flex-col gap-4 md:flex-row md:items-end">
        <Skeleton className="size-40 rounded-full md:size-48" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
