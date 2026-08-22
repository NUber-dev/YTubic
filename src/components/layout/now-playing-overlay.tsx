import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ShuffleIcon,
  RepeatIcon,
  Repeat1Icon,
  Loader2Icon,
  ChevronDownIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import { Thumbnail, pickHighResThumbnail } from "@/components/shared/thumbnail";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { ArtistLinks } from "@/components/shared/artist-links";
import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useScrubStore } from "@/lib/store/scrub";
import { useNowPlayingStore } from "@/lib/store/now-playing";
import { cn } from "@/lib/utils";

// Immersive full-window "Now Playing" screen: full-size cover left, synced
// karaoke lyrics right. Reuses the playback/scrub stores, the player-bar
// transport bits, and the LyricsBody/useLyricsView engine — only layout is new.
export function NowPlayingOverlay() {
  const { playing, status, position, duration, shuffle, repeat } =
    usePlaybackStore(
      useShallow((s) => ({
        playing: s.playing,
        status: s.status,
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

  const scrub = useScrubStore((s) => s.scrub);
  const setScrub = useScrubStore((s) => s.setScrub);
  const setOpen = useNowPlayingStore((s) => s.setOpen);

  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);
  const reduce = useReducedMotion();

  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Esc closes + focus moves in on open, restored on close. The
  // `defaultPrevented` guard lets Radix close an open menu/tooltip first.
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocused?.focus?.();
    };
  }, [setOpen]);

  if (!track) return null;

  const loading = status === "loading" && playing;
  const coverUrl = pickHighResThumbnail(track.thumbnails);

  const overlay = (
    // Own provider: the overlay mounts inside SidebarProvider's delay=0 one.
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
      {/* `dark`: reused components stay legible over the dark backdrop.
          `top-(--titlebar-h)`: keep the OS window controls usable. */}
      <motion.div
        role="region"
        aria-label="Now playing"
        initial={{ opacity: 0, scale: reduce ? 1 : 0.99 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduce ? 0.12 : 0.2, ease: "easeOut" }}
        className="dark fixed inset-x-0 bottom-0 top-(--titlebar-h) z-40 flex flex-col overflow-hidden bg-background text-foreground"
      >
        {/* Blurred cover backdrop + scrim to keep lyrics readable over it. */}
        {coverUrl ? (
          <img
            key={coverUrl}
            src={coverUrl}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover blur-3xl saturate-150 opacity-35"
          />
        ) : null}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black/55"
        />

        {/* Top bar — draggable strip (the title bar's own is behind the overlay). */}
        <div
          data-tauri-drag-region
          className="relative flex shrink-0 items-center justify-end px-4 pt-4 pb-2"
        >
          <Button
            ref={closeBtnRef}
            variant="ghost"
            size="icon"
            aria-label="Close now playing"
            onClick={() => setOpen(false)}
            className="size-11 rounded-full bg-black/35 text-white shadow-sm ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-black/60 hover:text-white"
          >
            <ChevronDownIcon className="size-7" />
          </Button>
        </div>

        {/* Cover+controls left, lyrics right; stacks when narrow. Every lyrics
            ancestor is a `min-h-0` flex column so its `h-full` scroller resolves. */}
        <div className="relative flex min-h-0 flex-1 flex-col gap-6 px-6 pb-8 lg:flex-row lg:gap-10 lg:px-10">
          {/* LEFT: cover + controls */}
          <div className="flex min-h-0 flex-col items-center justify-center gap-5 lg:w-2/5">
            <div className="relative isolate aspect-square w-full max-w-[min(70vw,38vh)] rounded-xl shadow-[0_8px_40px_rgb(0_0_0/0.45)] lg:max-w-[min(80vw,58vh)]">
              <Thumbnail
                thumbnails={track.thumbnails}
                alt={track.title}
                className="size-full rounded-xl pointer-events-none"
                targetSize={1024}
                highRes
                overrideHighRes={iTunesCover}
              />
              <ArtworkOutline className="rounded-xl" />
            </div>

            {/* Title + artist + like */}
            <div className="flex w-full max-w-xl items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-2xl font-semibold text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
                  {track.title}
                </span>
                <ArtistLinks
                  artists={track.artists}
                  fallback={track.subtitle ?? ""}
                  className="truncate text-base text-white/70 [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
                />
              </div>
              <LikeDislikeButtons
                videoId={track.videoId}
                track={track}
                className="shrink-0"
              />
            </div>

            {/* Progress */}
            <div className="flex w-full max-w-xl flex-col gap-2">
              <ProgressSlider
                position={position}
                duration={duration}
                scrub={scrub}
                setScrub={setScrub}
                seek={seek}
                disabled={duration <= 0}
              />
              <div className="flex justify-between text-xs tabular-nums text-white/70">
                <span>{formatTime(scrub ?? position)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Transport — the player-bar cluster, inlined and scaled up. */}
            <div className="flex items-center justify-center gap-2 text-white">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Shuffle"
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
                className={cn("hover:bg-white/10", shuffle && "text-brand")}
              >
                <ShuffleIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous"
                onClick={prev}
                className="hover:bg-white/10"
              >
                <SkipBackIcon className="fill-current" />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                className="size-14 rounded-full bg-brand text-white hover:bg-brand/90"
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
                className="hover:bg-white/10"
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
                    className={cn(
                      "hover:bg-white/10",
                      repeat !== "off" && "text-brand",
                    )}
                  >
                    {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{repeatLabel(repeat)}</TooltipContent>
              </Tooltip>
            </div>

            {/* Volume + lyrics source + more */}
            <div className="flex items-center justify-center gap-1">
              <VolumeControl />
              <LyricsSourceButton state={lyricsState} />
              <PlayerMoreMenu track={track} />
            </div>
          </div>

          {/* RIGHT: synced lyrics. `np-lyrics` scopes the overlay overrides
              (index.css); text-shadow is a contrast safety net over the scrim. */}
          <div className="flex min-h-0 flex-1 flex-col lg:w-3/5">
            <div className="np-lyrics min-h-0 flex-1 [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]">
              <LyricsBody state={lyricsState} />
            </div>
          </div>
        </div>
      </motion.div>
    </TooltipProvider>
  );

  return createPortal(overlay, document.body);
}
