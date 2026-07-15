import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ShuffleIcon,
  RepeatIcon,
  Repeat1Icon,
  VolumeIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
  Loader2Icon,
  MusicIcon,
  VideoIcon,
} from "lucide-react";
import { QueueBody, QueueToggleButton } from "@/components/layout/queue-panel";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import { Thumbnail } from "@/components/shared/thumbnail";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { ArtistLinks } from "@/components/shared/artist-links";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { cn } from "@/lib/utils";
import { usePlayerCoverDrag } from "@/lib/player-drag";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import {
  useTrackSourceStore,
  type SourceKind,
} from "@/lib/store/track-source";
import { findAlternateVideoId } from "@/lib/innertube/alternate-source";
import { lookupITunesCover, cacheCoverToDisk } from "@/lib/cover-art";
import type { QueueTrack, RepeatMode } from "@/lib/store/playback";

/**
 * Look up a 3000×3000 studio cover from iTunes for the now-playing
 * track. We do this only for the big player-bar cover — every other
 * surface keeps the YT thumbnail (smaller surfaces don't need 3K, and
 * substituting iTunes art on cards would visually rewrite content the
 * user picked from YT). Result is cached in localStorage, so repeat
 * tracks don't hit the network.
 */
export function useITunesCover(track: QueueTrack | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const artistKey = track?.artists?.map((a) => a.name).join(", ") ?? "";
  const titleKey = track?.title ?? "";

  useEffect(() => {
    setUrl(null);
    if (!artistKey || !titleKey) return;
    let cancelled = false;
    (async () => {
      const itunes = await lookupITunesCover(artistKey, titleKey);
      if (cancelled || !itunes) return;
      const cached = await cacheCoverToDisk(itunes);
      if (cancelled) return;
      setUrl(cached);
    })();
    return () => {
      cancelled = true;
    };
  }, [artistKey, titleKey]);

  return url;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Human label for the current repeat mode. Doubles as the button's
 * tooltip and its `aria-label` so the three states (off → all → one)
 * are distinguishable — otherwise "off" and "all" differ only by the
 * icon's tint, which reads as "nothing happened" on the first click.
 */
export function repeatLabel(repeat: RepeatMode): string {
  return repeat === "one"
    ? "Repeat one"
    : repeat === "all"
      ? "Repeat all"
      : "Repeat off";
}

/**
 * Segmented song/video toggle. Displayed as two tightly grouped icons —
 * the active one filled, the other ghosted — matching the layout
 * reference. Clicking either side switches to that source; if the
 * alternate videoId hasn't been resolved yet, we fetch it on demand.
 */
export function SourceToggle({ track }: { track: QueueTrack }) {
  const record = useTrackSourceStore((s) => s.byVideoId[track.videoId]);
  const setSelected = useTrackSourceStore((s) => s.setSelected);
  const setAlternate = useTrackSourceStore((s) => s.setAlternate);
  const [busy, setBusy] = useState<SourceKind | null>(null);

  const selected: SourceKind = record?.selected ?? "song";

  const switchTo = async (target: SourceKind) => {
    if (busy || target === selected) return;
    const cachedAlt = target === "video" ? record?.video : record?.song;
    if (cachedAlt) {
      setSelected(track.videoId, target);
      return;
    }
    setBusy(target);
    try {
      const artistsLine = track.artists?.map((a) => a.name).join(" ") ?? "";
      const query = `${track.title} ${artistsLine}`.trim();
      const altId = await findAlternateVideoId(query, track.videoId, target);
      if (!altId) {
        toast.error(
          target === "video"
            ? "No video version found"
            : "No song version found",
        );
        return;
      }
      setAlternate(track.videoId, target, altId);
      setSelected(track.videoId, target);
    } catch (e) {
      toast.error(`Couldn't switch source: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Song version"
            aria-pressed={selected === "song"}
            onClick={() => switchTo("song")}
            disabled={busy !== null}
            className={cn(
              "flex size-7 items-center justify-center rounded-sm transition-colors",
              selected === "song"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-white/10 hover:text-foreground",
            )}
          >
            {busy === "song" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <MusicIcon className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Song version</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Video version"
            aria-pressed={selected === "video"}
            onClick={() => switchTo("video")}
            disabled={busy !== null}
            className={cn(
              "flex size-7 items-center justify-center rounded-sm transition-colors",
              selected === "video"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-white/10 hover:text-foreground",
            )}
          >
            {busy === "video" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <VideoIcon className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Video version</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ProgressSlider({
  position,
  duration,
  scrub,
  setScrub,
  seek,
  disabled,
}: {
  position: number;
  duration: number;
  scrub: number | null;
  setScrub: (v: number | null) => void;
  seek: (v: number) => void;
  disabled: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // While the user is dragging the thumb, the slider thumb captures pointer
  // events so onMouseMove on the wrapper stops firing. Sync the tooltip with
  // the live `scrub` value instead.
  useEffect(() => {
    if (scrub === null) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const max = Math.max(duration, 1);
    setHoverX((scrub / max) * rect.width);
    setHoverTime(Math.round(scrub));
  }, [scrub, duration]);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']",
        !disabled && "cursor-pointer",
      )}
      onMouseMove={(e) => {
        if (disabled || scrub !== null) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        setHoverX(x);
        setHoverTime(Math.round((x / rect.width) * Math.max(duration, 1)));
      }}
      onMouseLeave={() => {
        if (scrub !== null) return;
        setHoverX(null);
        setHoverTime(null);
      }}
    >
      {hoverX !== null && hoverTime !== null ? (
        <div
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded bg-black/85 px-2 py-0.5 text-sm font-medium tabular-nums text-white shadow"
          style={{ left: hoverX }}
        >
          {formatTime(hoverTime)}
        </div>
      ) : null}
      <Slider
        value={[scrub ?? position]}
        max={Math.max(duration, 1)}
        step={1}
        disabled={disabled}
        onValueChange={([v]) => setScrub(v)}
        onValueCommit={([v]) => {
          seek(v);
          setScrub(null);
        }}
        className="[&_[data-slot=slider-track]]:bg-white/20"
      />
    </div>
  );
}

export function VolumeControl({
  direction = "horizontal",
}: {
  direction?: "horizontal" | "vertical";
}) {
  const { volume, muted } = usePlaybackStore(
    useShallow((s) => ({ volume: s.volume, muted: s.muted })),
  );
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const [open, setOpen] = useState(false);

  const Icon =
    muted || volume === 0
      ? VolumeXIcon
      : volume <= 0.15
        ? VolumeIcon
        : volume < 0.6
          ? Volume1Icon
          : Volume2Icon;
  const pct = muted ? 0 : Math.round(volume * 100);

  // Horizontal: slider sits to the right of the speaker icon (right
  // card variant — there's room beside the button).
  // Vertical: slider pops upward (bottom bar — below the button is
  // the page edge, so the popup has to grow up).
  // Padding on the popup is invisible but counts toward the parent's
  // mouseleave hit-test, so the slider doesn't snap shut the moment
  // the cursor slips a couple px off the visible bar.
  const popupClass =
    direction === "vertical"
      ? "absolute bottom-full left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 px-3 pb-2 transition-opacity duration-150"
      : "absolute left-full top-1/2 z-10 flex -translate-y-1/2 items-center gap-0 py-3 pl-1 transition-opacity duration-150";

  return (
    <div
      // Two invisible 8px strips (above and below the speaker button)
      // extend the container's hover hit-zone without overlapping the
      // button itself — overlapping it would steal its `:hover` state.
      // Together with the popup's own padding, the cursor gets a
      // comfortable grace area for traveling between icon and slider.
      className="relative flex items-center before:absolute before:-top-2 before:inset-x-0 before:h-2 before:content-[''] after:absolute after:-bottom-2 after:inset-x-0 after:h-2 after:content-['']"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onWheel={(e) => {
        // Scroll wheel adjusts volume in 5% increments. Wheel-up
        // raises, wheel-down lowers. Unmutes on any change so the
        // change is audible.
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        // Adjust from the stored volume even when muted, so unmuting via the
        // wheel restores the real level instead of resetting to 5%.
        // setVolume already clears `muted`, so any wheel tick unmutes.
        const next = Math.max(0, Math.min(1, volume + delta));
        setVolume(next);
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={toggleMute}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={Icon.displayName ?? Icon.name}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.12 }}
            className="flex items-center justify-center"
          >
            <Icon />
          </motion.span>
        </AnimatePresence>
      </Button>
      <div
        className={cn(
          popupClass,
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {direction === "vertical" ? (
          <div className="flex w-12 flex-col items-center gap-2 rounded-md border border-hairline bg-surface-active/70 px-4 py-3 shadow backdrop-blur-md">
            <span className="text-xs font-medium tabular-nums text-foreground">
              {pct}
            </span>
            <Slider
              orientation="vertical"
              value={[pct]}
              max={100}
              step={1}
              className="h-16 min-h-0 [&_[data-slot=slider-track]]:bg-white/20"
              aria-label="Volume"
              onValueChange={([v]) => setVolume(v / 100)}
            />
          </div>
        ) : (
          <>
            <Slider
              value={[pct]}
              max={100}
              step={1}
              className="w-16 [&_[data-slot=slider-track]]:bg-white/20"
              aria-label="Volume"
              onValueChange={([v]) => setVolume(v / 100)}
            />
            <span className="w-7 text-right text-xs font-medium tabular-nums text-foreground">
              {pct}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export type PlayerBarVariant = "right" | "floating";

export function PlayerBar({
  variant = "right",
}: {
  variant?: PlayerBarVariant;
}) {
  const {
    playing,
    status,
    error,
    position,
    duration,
    shuffle,
    repeat,
  } = usePlaybackStore(
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
  const [queueOpen, setQueueOpen] = useState(false);
  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  // The cover doubles as a drag handle for layout switching. In the
  // floating window the OS title bar already owns drag, so we don't
  // attach our own handler there.
  const { onPointerDown: onCoverPointerDown } = usePlayerCoverDrag({
    enabled: variant !== "floating",
  });

  const hasTrack = !!track;
  // Only treat "loading" as user-facing when the user has actually
  // requested playback. The audio engine eagerly resolves the stream
  // URL for the queued track on mount (so the first click on Play is
  // instant), which flips status to "loading" even while playing is
  // still false — without this guard, the freshly-launched player
  // shows a spinner instead of the Play icon.
  const loading = status === "loading" && playing;

  // The right-side variant is fixed-positioned in the main app shell.
  // The floating-window variant fills its parent container (the
  // floating window's body), where positioning is owned by that
  // window's own layout.
  const wrapperClass =
    variant === "right"
      ? "fixed bottom-2 right-2 top-(--titlebar-h) z-10 flex w-[22rem] flex-col rounded-[10px] border border-sidebar-border bg-surface"
      : "absolute inset-0 flex flex-col bg-surface";

  return (
    // shadcn's SidebarProvider injects a nested TooltipProvider with
    // delayDuration={0} (for instant sidebar-icon labels), which
    // shadows the outer 800ms provider for everything inside the
    // shell. Wrap the player surface in its own provider so its
    // buttons get the slow delay we actually want here.
    // `skipDelayDuration={0}` makes EVERY hover wait the full delay,
    // even when moving between adjacent triggers (Radix defaults to
    // 300ms, which makes the next tooltip pop up instantly — annoying
    // when the buttons are densely packed).
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
    <aside className={wrapperClass}>
      {/* Queue overlay vs. cover-and-lyrics body. AnimatePresence
          crossfades the two when the user toggles the queue button.
          Both branches fill the card above the bottom action row
          (which stays rendered as the next aside child so the queue
          button remains accessible to toggle back). `initial={false}`
          suppresses an opening fade on first mount — the player
          opens with the cover already visible, no need to animate it
          in from blank. */}
      <AnimatePresence initial={false} mode="wait">
        {queueOpen ? (
          <motion.div
            key="queue"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.07 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <QueueBody onClose={() => setQueueOpen(false)} />
          </motion.div>
        ) : (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.07 }}
            className="flex min-h-0 flex-1 flex-col"
          >
      {/* Top fixed section: cover, meta, progress, controls.
          Floating variant drops the top padding so the cover sits
          flush against the window's title bar — there's no card
          border or chrome to motivate inset there. */}
      <div
        className={cn(
          "flex flex-col gap-3 p-4 pb-3",
          variant === "floating" && "pt-0",
        )}
      >
        {status === "error" && error ? (
          <div className="truncate rounded-md bg-destructive/90 px-3 py-1 text-xs text-destructive-foreground shadow">
            Playback error: {error}
          </div>
        ) : null}

        {/* `max-w-[20rem]` caps the cover at 320px so it can't grow
            arbitrarily tall in the floating variant when the user
            resizes the window wider — that would push the Play/Pause
            button below the visible area. The right-card variant has
            an effective inner width of 320 anyway (22rem - p-4*2), so
            the cap is a no-op there. */}
        <div
          onPointerDown={onCoverPointerDown}
          className={cn(
            "mx-auto w-full max-w-[20rem] touch-none select-none",
            variant !== "floating" && "cursor-grab active:cursor-grabbing",
          )}
        >
          {track ? (
            <Thumbnail
              thumbnails={track.thumbnails}
              alt={track.title}
              className="aspect-square w-full rounded-md border border-hairline pointer-events-none"
              targetSize={1024}
              highRes
              overrideHighRes={iTunesCover}
            />
          ) : (
            <div className="aspect-square w-full rounded-md border border-hairline bg-muted" />
          )}
        </div>

        {/* Title + artist with heart on the right */}
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-medium">
              {track?.title ?? "Nothing playing"}
            </span>
            {track ? (
              <ArtistLinks
                artists={track.artists}
                fallback={track.subtitle ?? ""}
                className="truncate text-sm text-muted-foreground"
              />
            ) : (
              <span className="truncate text-sm text-muted-foreground">
                Pick a track to start
              </span>
            )}
          </div>
          {track ? (
            <LikeDislikeButtons videoId={track.videoId} track={track} className="-mt-1" />
          ) : null}
        </div>

        {/* Progress */}
        <div className="mt-2 flex flex-col gap-2.5">
          <ProgressSlider
            position={position}
            duration={duration}
            scrub={scrub}
            setScrub={setScrub}
            seek={seek}
            disabled={!hasTrack || duration <= 0}
          />
          <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
            <span>{formatTime(scrub ?? position)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Main controls */}
        <div className="-mt-2 flex items-center justify-center gap-1">
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
              <PauseIcon className="fill-current" />
            ) : (
              <PlayIcon className="fill-current" />
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
      </div>

            {/* Lyrics flow — fills the rest of the cover-branch flex
                column. Lives inside the same motion.div as the cover
                so the whole non-queue body crossfades as one unit. */}
            <div className="flex min-h-0 flex-1 flex-col px-3">
              <LyricsBody state={lyricsState} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom row: lyrics-source + queue + volume on the left,
          song/video toggle + more menu on the right. `PlayerMoreMenu`
          handles the floating-window case internally — its
          `onGoToArtist` callback emits a Tauri nav event there
          instead of calling `useNavigate` (which would throw without
          a router). */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-3">
        <div className="flex items-center gap-0.5">
          <LyricsSourceButton state={lyricsState} />
          <QueueToggleButton
            open={queueOpen}
            onToggle={() => setQueueOpen((v) => !v)}
          />
          <VolumeControl />
        </div>
        <div className="flex items-center gap-1">
          {track && <SourceToggle track={track} />}
          <PlayerMoreMenu track={track} includeSource={false} />
        </div>
      </div>
    </aside>
    </TooltipProvider>
  );
}
