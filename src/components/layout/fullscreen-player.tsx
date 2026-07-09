import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  ChevronDownIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  Repeat1Icon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LyricsBody, useLyricsView } from "@/components/layout/lyrics-view";
import {
  ProgressSlider,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import {
  Thumbnail,
  pickHighResThumbnail,
} from "@/components/shared/thumbnail";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { cn } from "@/lib/utils";

// Local copy of the lyrics-feel resting ratio so this view centers the
// active line just below middle on its tall canvas without depending on
// the lyrics component's inline-panel default.
const FULLSCREEN_LYRICS_VIEWPORT_RATIO = 0.45;

/**
 * Immersive now-playing view: full-window overlay with the album art
 * blown up and blurred as an ambient backdrop, the artwork itself sharp
 * in the foreground, the synced-lyrics flow beside it when the track has
 * lyrics (and centered art alone when it doesn't), and transport
 * controls pinned along the bottom. Opened from the expand button in the
 * player card; Esc or the chevron collapses it back.
 *
 * The accent for the seek fill, play button, and active toggles is
 * pulled from the cover art by a Rust command (a client-side canvas read
 * taints on the CORS-less art CDNs), falling back to the brand red.
 *
 * Rendered through a portal so the fixed overlay can't be trapped by a
 * transformed/filtered ancestor inside the player card (either would
 * silently turn `position: fixed` into "fixed to that box").
 */
export function FullscreenPlayer({ onClose }: { onClose: () => void }) {
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

  const [scrub, setScrub] = useState<number | null>(null);
  const iTunesCover = useITunesCover(track);
  const lyricsState = useLyricsView(track);

  // Reserve the lyrics pane while a lookup is still in flight or once it
  // lands; only collapse to the centered-art layout when the fetch has
  // resolved with nothing, so we never flash "No lyrics found." or an
  // empty right-hand column.
  const showLyrics = lyricsState.isLoading || !!lyricsState.active;

  // Album duration metadata covers the window where the audio element
  // hasn't reported its own length yet (progressive streams report it
  // late), so the bar and total aren't stuck at 0:00.
  const knownDuration = duration > 0 ? duration : (track?.duration ?? 0);

  // Ambient backdrop + foreground share one artwork source.
  const backdropUrl =
    iTunesCover ?? pickHighResThumbnail(track?.thumbnails ?? []);

  // Vibrant accent from the cover, computed server-side. Falls back to
  // the brand red (we simply don't override the vars) until it resolves.
  const [accent, setAccent] = useState<string | null>(null);
  useEffect(() => {
    if (!backdropUrl) {
      setAccent(null);
      return;
    }
    let cancelled = false;
    void invoke<string>("dominant_accent_color", { url: backdropUrl })
      .then((hex) => {
        if (!cancelled) setAccent(hex);
      })
      .catch(() => {
        if (!cancelled) setAccent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [backdropUrl]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Queue emptied while open (clear queue from the tray, last track
  // removed) means nothing to show, so fold back to the normal layout.
  useEffect(() => {
    if (!track) onClose();
  }, [track, onClose]);

  if (!track) return null;

  const loading = status === "loading" && playing;
  // Remap the brand tokens to the extracted accent for everything inside
  // the overlay: the seek fill (`bg-primary`), play button (`bg-brand`),
  // and active shuffle/repeat icons (`text-brand`) all follow.
  const accentStyle = accent
    ? ({
        "--player-accent": accent,
        "--brand": "var(--player-accent)",
        "--primary": "var(--player-accent)",
      } as React.CSSProperties)
    : undefined;

  return createPortal(
    // The overlay carries its own TooltipProvider for the same reason
    // the player card does: it must not inherit the sidebar's 0ms one.
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        style={accentStyle}
        className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
        role="dialog"
        aria-label="Now playing"
      >
        {/* Ambient backdrop: the cover blown past the edges and heavily
            blurred, darkened for text contrast, plus the noise layer
            BackgroundCover uses to break up banding in the blur. Always
            on in fullscreen, behind both layouts. */}
        {backdropUrl ? (
          <img
            src={backdropUrl}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-[80px] saturate-150"
          />
        ) : null}
        <div aria-hidden className="absolute inset-0 bg-black/60" />
        <div aria-hidden className="bg-cover-noise absolute inset-0" />

        <div className="relative z-10 flex h-full min-h-0 flex-col px-[6vw] pt-(--titlebar-h)">
          <div className="flex justify-end pt-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Exit full screen"
                  onClick={onClose}
                >
                  <ChevronDownIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Exit full screen (Esc)</TooltipContent>
            </Tooltip>
          </div>

          {/* Center stage: artwork, with the lyrics column beside it only
              when the track actually has lyrics. Without them the art
              centers on its own. Sized off the viewport so both stay
              clear of the bottom control strip. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 items-center justify-center py-4",
              showLyrics && "gap-[5vw]",
            )}
          >
            <div className="shrink-0">
              <Thumbnail
                thumbnails={track.thumbnails}
                alt={track.title}
                className="size-[min(52vh,34vw)] rounded-lg border border-hairline object-cover shadow-2xl"
                targetSize={1024}
                highRes
                overrideHighRes={iTunesCover}
              />
            </div>
            {/* Bump the line size for the big canvas. The descendant
                selector outweighs the component's own `text-lg`, so the
                shared lyrics component stays untouched. */}
            {showLyrics ? (
              <div className="flex h-[min(58vh,40rem)] w-[min(38rem,42vw)] min-w-0 flex-col [&_.lyrics-line]:text-2xl">
                <LyricsBody
                  state={lyricsState}
                  viewportRatio={FULLSCREEN_LYRICS_VIEWPORT_RATIO}
                />
              </div>
            ) : null}
          </div>

          {/* Bottom strip: meta, progress, transport. */}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 pb-7">
            <div className="flex flex-col items-center gap-0.5 text-center">
              <span className="max-w-full truncate text-lg font-semibold">
                {track.title}
              </span>
              <span className="max-w-full truncate text-sm text-muted-foreground">
                {track.artists?.map((a) => a.name).join(", ") ??
                  track.subtitle ??
                  ""}
              </span>
            </div>
            <ProgressSlider
              position={position}
              duration={knownDuration}
              scrub={scrub}
              setScrub={setScrub}
              seek={seek}
              disabled={knownDuration <= 0}
            />
            <div className="-mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>{formatTime(scrub ?? position)}</span>
              <span>{formatTime(knownDuration)}</span>
            </div>
            <div className="relative -mt-1 flex items-center justify-center gap-1">
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
              <Button variant="ghost" size="icon" aria-label="Previous" onClick={prev}>
                <SkipBackIcon className="fill-current" />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
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
              <Button variant="ghost" size="icon" aria-label="Next" onClick={next}>
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
              <div className="absolute right-0">
                <VolumeControl direction="vertical" />
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </TooltipProvider>,
    document.body,
  );
}
