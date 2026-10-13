import { useEffect, useState, type ReactNode } from "react";
import {
  LyricsBody,
  type LyricsViewState,
} from "@/components/layout/lyrics-view";
import {
  ChaptersBody,
  useVideoChapters,
} from "@/components/layout/chapters-view";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { cn } from "@/lib/utils";

type Tab = "lyrics" | "chapters";

/**
 * The flowing area under the player cover: lyrics, or lyrics/chapters
 * tabs when the current video has linked YouTube chapters (OST dumps,
 * long mixes, uploaded concerts).
 */
export function PlayerMediaPanel({
  videoId,
  lyricsState,
  trailing,
  headerClassName,
}: {
  videoId: string | undefined;
  lyricsState: LyricsViewState;
  /** Extra header control — the lyrics-source picker on the bottom-bar popover. */
  trailing?: ReactNode;
  headerClassName?: string;
}) {
  const chaptersQuery = useVideoChapters(videoId);
  const chapters = chaptersQuery.data ?? null;
  const hasChapters = !!chapters && chapters.length >= 2;

  const [tab, setTab] = useState<Tab>("lyrics");
  const [chosen, setChosen] = useState(false);

  useEffect(() => {
    setTab("lyrics");
    setChosen(false);
  }, [videoId]);

  useEffect(() => {
    if (!chosen && hasChapters) setTab("chapters");
  }, [hasChapters, chosen]);

  const showHeader = hasChapters || trailing != null;
  const active: Tab = hasChapters ? tab : "lyrics";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {showHeader ? (
        <div
          className={cn(
            "flex shrink-0 items-center justify-between gap-2",
            headerClassName,
          )}
        >
          {hasChapters ? (
            <AnimatedTabs
              activeTab={active}
              onChange={(id) => {
                setChosen(true);
                setTab(id as Tab);
              }}
              variant="underline"
              className="border-b-0 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm"
              tabs={[
                { id: "lyrics", label: "Lyrics" },
                { id: "chapters", label: "Chapters" },
              ]}
            />
          ) : trailing ? (
            <span className="px-1 text-sm font-medium">Lyrics</span>
          ) : null}
          {trailing}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {active === "chapters" && chapters ? (
          <ChaptersBody chapters={chapters} />
        ) : (
          <LyricsBody state={lyricsState} />
        )}
      </div>
    </div>
  );
}