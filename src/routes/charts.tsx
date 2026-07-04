import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchChartsFeedPage } from "@/lib/innertube/explore";

export const Route = createFileRoute("/charts")({
  component: ChartsPage,
});

function ChartsPage() {
  return (
    <FeedView
      title="Charts"
      queryKey={["charts", "v1"]}
      fetcher={fetchChartsFeedPage}
      errorLabel="Couldn't load Charts"
    />
  );
}
