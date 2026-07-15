import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ShuffleIcon,
  RepeatIcon,
  Repeat1Icon,
  Loader2Icon,
  MicVocalIcon,
} from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Thumbnail } from "@/components/shared/thumbnail";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { ArtistLinks } from "@/components/shared/artist-links";
import { QueuePopover } from "@/components/layout/queue-panel";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import {
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { cn } from "@/lib/utils";
import { usePlayerCoverDrag } from "@/lib/player-drag";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";

/**
 * Compact horizontal player bar pinned to the bottom of the content
 * area. Sibling of `<main>` (not fixed-positioned), so it naturally
 * sits between the sidebar on the left and the right window edge —
 * no manual sidebar-width math.
 *
 * Layout: meta + transport + secondary actions in a single top row,
 * progress slider + flanking timecodes in a row below. The transport
 * cluster sits dead-center because the left and right wing sections
 * both use `flex-1`.
 */
export function PlayerBarBottom() {
  const { playing, status, error, position, duration, shuffle, repeat } =
    usePlaybackStore(
      useShallow((s) => ({
        playing: s.playing,
        status: s.status,
        error: s.error,
        position: s.position,
        duration: s.duration,
        shuffle: s.shuffle,
        repeat: s.repeat,
      })),
    );
  const track = usePlaybackStore(currentTrack);
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);

  const [scrub, setScrub] = useState<number | null>(null);
  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  const { onPointerDown: onCoverPointerDown } = usePlayerCoverDrag();

  const hasTrack = !!track;
  // See player-bar.tsx — spinner only while the user has actually
  // requested playback, otherwise eager stream preloading shows a
  // loader where a Play icon should be.
  const loading = status === "loading" && playing;

  return (
    // The compound selector at the end overrides shadcn's ghost-variant
    // gray hover (`hover:bg-accent`) for every Button rendered inside
    // the bar — both the ones we render directly (shuffle/prev/next/
    // repeat) and the ones from imported components (Like, Lyrics,
    // Queue, Volume, More). Matches the right-card's translucent
    // white feel.
    // Right margin only (`mr-2` = 8px) matches the sidebar's own
    // 8px inset from the window edges. The sidebar's `data-slot=sidebar-container`
    // already eats 8px on its right side via shadcn's `p-2`, so a 0px
    // left margin here lands the bar's left edge 8px away from the
    // sidebar's visible right edge — symmetric with how the sidebar
    // sits 8px from the window-left.
    // SidebarProvider injects a nested TooltipProvider with delay=0
    // that shadows the outer slow one — wrap this surface so its
    // tooltips honor the intended 1s delay. `skipDelayDuration={0}`
    // makes every hover wait the full delay even when moving between
    // adjacent triggers (Radix's 300ms default makes the next one
    // pop up instantly otherwise).
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
    <aside
      className="relative z-10 mr-2 mb-2 flex shrink-0 flex-col gap-2 rounded-[10px] border border-sidebar-border bg-surface px-4 py-3 shadow-sm"
    >
      {status === "error" && error ? (
        <div className="absolute -top-9 left-3 right-3 truncate rounded-md bg-destructive/90 px-3 py-1 text-xs text-destructive-foreground shadow">
          Playback error: {error}
        </div>
      ) : null}

      {/* Top row — three sections separated by `flex-1` wings so the
          transport cluster always lands centered in the bar. */}
      <div className="flex items-center gap-4">
        {/* LEFT wing: cover + meta. `min-w-0` lets the title truncate
            instead of pushing the transport cluster off-center. */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            onPointerDown={onCoverPointerDown}
            className="shrink-0 touch-none select-none cursor-grab active:cursor-grabbing"
          >
            {track ? (
              <Thumbnail
                thumbnails={track.thumbnails}
                alt={track.title}
                className="size-14 shrink-0 rounded-md border border-hairline pointer-events-none"
                targetSize={256}
                highRes
                overrideHighRes={iTunesCover}
              />
            ) : (
              <div className="size-14 shrink-0 rounded-md border border-hairline bg-muted" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-base font-semibold leading-tight">
              {track?.title ?? "Nothing playing"}
            </span>
            {track ? (
              <ArtistLinks
                artists={track.artists}
                fallback={track.subtitle ?? ""}
                className="truncate text-sm text-muted-foreground leading-tight"
              />
            ) : (
              <span className="truncate text-sm text-muted-foreground leading-tight">
                Pick a track to start
              </span>
            )}
          </div>
        </div>

        {/* CENTER: shuffle | prev | PLAY | next | repeat. Width is
            implicit (no flex-1) so the wings push it to the middle. */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => setShuffle(!shuffle)}
            className={cn(shuffle && "text-brand")}
          >
            <ShuffleIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous"
            onClick={prev}
            disabled={!hasTrack}
          >
            <SkipBackIcon className="fill-current" />
          </Button>
          <Button
            size="icon"
            aria-label={playing ? "Pause" : "Play"}
            onClick={toggle}
            disabled={!hasTrack}
            className="size-12 rounded-full bg-brand text-white hover:bg-brand/90"
          >
            {loading ? (
              <Loader2Icon className="animate-spin" />
            ) : playing ? (
              <PauseIcon className="size-5 fill-current" />
            ) : (
              <PlayIcon className="size-5 fill-current" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next"
            onClick={next}
            disabled={!hasTrack}
          >
            <SkipForwardIcon className="fill-current" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={repeatLabel(repeat)}
                aria-pressed={repeat !== "off"}
                onClick={cycleRepeat}
                className={cn(repeat !== "off" && "text-brand")}
              >
                {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{repeatLabel(repeat)}</TooltipContent>
          </Tooltip>
        </div>

        {/* RIGHT wing: secondary actions, justified to the right edge. */}
        <div className="flex flex-1 items-center justify-end gap-0.5">
          {track ? <LikeDislikeButtons videoId={track.videoId} track={track} /> : null}
          <LyricsPopover state={lyricsState} />
          <QueuePopover />
          <VolumeControl direction="vertical" />
          <PlayerMoreMenu track={track} />
        </div>
      </div>

      {/* Progress row — times sit at the bar's edges (intrinsic
          widths, no padding inside their boxes) so the LEFT time
          starts exactly under cover-left and the RIGHT time ends
          exactly under more-right. The slider fills whatever's left
          between them. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(scrub ?? position)}
        </span>
        <div className="min-w-0 flex-1">
          <ProgressSlider
            position={position}
            duration={duration}
            scrub={scrub}
            setScrub={setScrub}
            seek={seek}
            disabled={!hasTrack || duration <= 0}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatTime(duration)}
        </span>
      </div>
    </aside>
    </TooltipProvider>
  );
}

function LyricsPopover({
  state,
}: {
  state: ReturnType<typeof useLyricsView>;
}) {
  if (!state.hasTrack) {
    return (
      <Button variant="ghost" size="icon" disabled aria-label="Lyrics">
        <MicVocalIcon />
      </Button>
    );
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Lyrics">
              <MicVocalIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Lyrics</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={12}
        className="flex h-[28rem] w-[24rem] flex-col gap-2 p-0"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-2">
          <span className="text-sm font-medium">Lyrics</span>
          <LyricsSourceButton state={state} />
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-3">
          <LyricsBody state={state} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

