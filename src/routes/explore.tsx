import { useCallback } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  TrendingUpIcon,
  SparklesIcon,
  SmileIcon,
  type LucideIcon,
} from "lucide-react";
import { FeedView } from "@/components/shared/feed-view";
import { fetchExploreFeedPage } from "@/lib/innertube/explore";

export const Route = createFileRoute("/explore")({
  component: ExplorePage,
});

const SUBPAGES: {
  to: "/charts" | "/new-releases" | "/moods";
  label: string;
  blurb: string;
  icon: LucideIcon;
  // Tailwind gradient classes — kept inline so each tile has its own
  // distinct accent without a theme-wide token.
  gradient: string;
}[] = [
  {
    to: "/charts",
    label: "Charts",
    blurb: "Top songs, videos, and artists",
    icon: TrendingUpIcon,
    gradient: "bg-gradient-to-br from-[#170D35] to-[#560157]",
  },
  {
    to: "/new-releases",
    label: "New releases",
    blurb: "New albums, singles, and videos",
    icon: SparklesIcon,
    gradient: "bg-gradient-to-br from-[#0F0100] to-[#8E1B10]",
  },
  {
    to: "/moods",
    label: "Moods & genres",
    blurb: "Browse by mood, vibe, and genre",
    icon: SmileIcon,
    gradient: "bg-gradient-to-br from-[#03112E] to-[#263A7D]",
  },
];

function ExplorePage() {
  // The Explore feed has a top "grid of nav buttons" shelf that points
  // back at /charts, /new-releases, /moods — exactly what the hero tiles
  // below the title already cover. Strip those grid shelves so we don't
  // render the same three links twice.
  const fetcher = useCallback(async (cursor?: string) => {
    const page = await fetchExploreFeedPage(cursor);
    return {
      ...page,
      shelves: page.shelves.filter((s) => s.display !== "grid"),
    };
  }, []);

  return (
    <FeedView
      title="Explore"
      queryKey={["explore", "v1"]}
      fetcher={fetcher}
      errorLabel="Couldn't load Explore"
      header={
        <div className="@container">
          <div className="grid gap-3 grid-cols-1 @[50rem]:grid-cols-3">
          {SUBPAGES.map(({ to, label, blurb, icon: Icon, gradient }) => (
            <Link
              key={to}
              to={to}
              className={`group relative overflow-hidden rounded-xl ${gradient} px-5 py-4 transition-transform hover:scale-[1.01] active:scale-[0.99]`}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xl leading-none font-semibold text-white">
                    {label}
                  </span>
                  <span className="text-sm leading-none text-white/70">
                    {blurb}
                  </span>
                </div>
                <div className="relative size-12 shrink-0">
                  <div className="flex size-full items-center justify-center rounded-full bg-white/10 transition-colors group-hover:bg-white/15">
                    <Icon className="size-6 text-white" />
                  </div>
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-full border border-white opacity-10 mix-blend-difference"
                  />
                </div>
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-xl border border-white opacity-10 mix-blend-difference"
              />
            </Link>
          ))}
          </div>
        </div>
      }
    />
  );
}
