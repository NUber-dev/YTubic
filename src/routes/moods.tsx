import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchMoodsAndGenresFeedPage } from "@/lib/innertube/explore";

export const Route = createFileRoute("/moods")({
  component: MoodsPage,
});

function MoodsPage() {
  return (
    <FeedView
      title="Moods & genres"
      queryKey={["moods", "v1"]}
      fetcher={fetchMoodsAndGenresFeedPage}
      errorLabel="Couldn't load Moods & genres"
    />
  );
}
