import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { fetchAlbum } from "@/lib/innertube/album";
import { EntityHeader } from "@/components/shared/entity-header";
import { TrackList } from "@/components/shared/track-list";
import { JumpToCurrentButton } from "@/components/shared/jump-to-current-button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlaybackStore } from "@/lib/store/playback";

export const Route = createFileRoute("/album/$id")({
  component: AlbumPageView,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData({
      queryKey: ["album", params.id],
      queryFn: () => fetchAlbum(params.id),
    }),
});

function AlbumPageView() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["album", id],
    queryFn: () => fetchAlbum(id),
  });

  if (error) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">Couldn't load album</span>
          <span className="text-muted-foreground">
            {(error as Error).message}
          </span>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <AlbumSkeleton />;

  const subtitleParts = [
    ...data.artists.map((a) =>
      a.id ? (
        <Link
          key={a.id}
          to="/artist/$id"
          params={{ id: a.id }}
          className="hover:text-foreground hover:underline"
        >
          {a.name}
        </Link>
      ) : (
        <span key={a.name}>{a.name}</span>
      ),
    ),
  ];

  const metadataParts = [
    data.year,
    data.trackCount ? `${data.trackCount} songs` : undefined,
    data.duration,
  ].filter(Boolean) as string[];

  // Album rows don't carry a per-track thumbnail (the cover is shared at
  // the album level), so before queuing we backfill each row with the
  // album cover. Without this the player card and background cover render
  // empty for tracks played from an album page.
  const tracksWithCover = data.tracks.map((t) =>
    t.thumbnails.length > 0 ? t : { ...t, thumbnails: data.thumbnails },
  );

  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <EntityHeader
        title={data.title}
        thumbnails={data.thumbnails}
        metadata={metadataParts.join(" • ")}
        onPlay={() => {
          if (tracksWithCover.length > 0) {
            usePlaybackStore.getState().playShelfItems(tracksWithCover, 0);
            usePlaybackStore.getState().setShuffle(false);
          }
        }}
        onShuffle={() => {
          if (tracksWithCover.length > 0) {
            const start = Math.floor(Math.random() * tracksWithCover.length);
            usePlaybackStore
              .getState()
              .playShelfItems(tracksWithCover, start);
            usePlaybackStore.getState().setShuffle(true);
          }
        }}
      />
      {subtitleParts.length > 0 ? (
        <p className="-mt-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          {subtitleParts.map((node, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {node}
              {i < subtitleParts.length - 1 ? "," : ""}
            </span>
          ))}
        </p>
      ) : null}

      <JumpToCurrentButton tracks={tracksWithCover} />

      <TrackList tracks={tracksWithCover} hideThumbnails />
    </div>
  );
}

function AlbumSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
      <div className="flex flex-col gap-4 md:flex-row md:items-end">
        <Skeleton className="aspect-square w-40 md:w-56" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
