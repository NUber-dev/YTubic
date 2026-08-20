import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatTimestamp } from "@/lib/format";
import {
  fetchVideoChapters,
  type VideoChapter,
} from "@/lib/innertube/chapters";
import { usePlaybackStore } from "@/lib/store/playback";
import { useScrubStore } from "@/lib/store/scrub";
import { cn } from "@/lib/utils";

const ONE_HOUR = 60 * 60 * 1000;

export function useVideoChapters(videoId: string | undefined) {
  return useQuery({
    queryKey: ["chapters", "v1", videoId],
    queryFn: ({ signal }) => fetchVideoChapters(videoId, signal),
    enabled: !!videoId,
    staleTime: ONE_HOUR,
    retry: 1,
  });
}

function activeChapterIdx(chapters: VideoChapter[], position: number): number {
  let active = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].start <= position) active = i;
    else break;
  }
  return active;
}

export function ChaptersBody({ chapters }: { chapters: VideoChapter[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const playbackPosition = usePlaybackStore((s) => s.position);
  const seek = usePlaybackStore((s) => s.seek);
  const scrub = useScrubStore((s) => s.scrub);
  const position = scrub ?? playbackPosition;
  const activeIdx = activeChapterIdx(chapters, position);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-chapter-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIdx, chapters]);

  return (
    <div
      ref={scrollRef}
      className="lyrics-no-scrollbar lyrics-mask-bottom flex h-full flex-col gap-0.5 overflow-y-auto px-1 pb-12"
    >
      {chapters.map((ch, i) => {
        const active = i === activeIdx;
        return (
          <button
            key={`${ch.start}-${i}`}
            type="button"
            data-chapter-idx={i}
            onClick={() => seek(ch.start)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "grid grid-cols-[auto_1fr] items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              "hover:bg-black/30",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "text-xs tabular-nums",
                active ? "text-brand" : "text-muted-foreground",
              )}
            >
              {formatTimestamp(ch.start)}
            </span>
            <span
              className={cn(
                "min-w-0 text-sm leading-snug",
                active ? "font-medium text-foreground" : "text-foreground/80",
              )}
            >
              {ch.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}