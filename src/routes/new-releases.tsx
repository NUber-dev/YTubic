import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchNewReleasesFeedPage } from "@/lib/innertube/explore";

export const Route = createFileRoute("/new-releases")({
  component: NewReleasesPage,
});

function NewReleasesPage() {
  return (
    <FeedView
      title="New releases"
      queryKey={["new-releases", "v1"]}
      fetcher={fetchNewReleasesFeedPage}
      errorLabel="Couldn't load New releases"
    />
  );
}
