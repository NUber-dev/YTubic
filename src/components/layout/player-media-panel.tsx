import type { ReactNode } from "react";
import {
  LyricsBody,
  type LyricsViewState,
} from "@/components/layout/lyrics-view";
import { cn } from "@/lib/utils";

/**
 * The flowing lyrics area under the player cover, and inside the
 * bottom-bar popover. One component so both layouts stay in sync.
 */
export function PlayerMediaPanel({
  lyricsState,
  trailing,
  headerClassName,
}: {
  lyricsState: LyricsViewState;
  /** Extra header control — the lyrics-source picker on the bottom-bar popover. */
  trailing?: ReactNode;
  headerClassName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {trailing != null ? (
        <div
          className={cn(
            "flex shrink-0 items-center justify-between gap-2",
            headerClassName,
          )}
        >
          <span className="px-1 text-sm font-medium">Lyrics</span>
          {trailing}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <LyricsBody state={lyricsState} />
      </div>
    </div>
  );
}
