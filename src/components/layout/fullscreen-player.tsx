import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { toast } from "sonner";
import { fetchLikedSongs } from "@/lib/innertube/library";
import { toggleDisliked, toggleLiked } from "@/lib/like-actions";
import { useDislikesStore } from "@/lib/store/dislikes";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import {
  PlayIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ShuffleIcon,
  RepeatIcon,
  Repeat1Icon,
  Loader2Icon,
} from "lucide-react";
import { IconArrowsMinimize } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { ArtistLinks } from "@/components/shared/artist-links";
import { EntityLink } from "@/components/shared/entity-link";
import { getLikedIdsSet } from "@/components/shared/like-buttons";
import { Thumbnail } from "@/components/shared/thumbnail";
import { LyricsBody, useLyricsView } from "@/components/layout/lyrics-view";
import {
  ProgressSlider,
  SourceToggle,
  VolumeControl,
  formatTime,
  repeatLabel,
  useITunesCover,
} from "@/components/layout/player-bar";
import { PlayerMoreMenu } from "@/components/layout/player-more-menu";
import { QueuePopover } from "@/components/layout/queue-panel";
import { LyricsSourceButton } from "@/components/layout/lyrics-view";
import { cn } from "@/lib/utils";
import { useFullscreenStore } from "@/lib/store/fullscreen";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { useScrubStore } from "@/lib/store/scrub";
import { useSettingsStore, type FullscreenLayout } from "@/lib/store/settings";
import { useTrackSourceStore } from "@/lib/store/track-source";
import { videoStreamUrlFor } from "@/lib/stream";
import { getVideoQualityTier, reportPlaybackStutter } from "@/lib/video-quality";
import { useVideoGateStore } from "@/lib/store/video-gate";
import { getAudioClock } from "@/lib/audio-clock";

const VIDEO_WAIT_CEILING_MS = 45_000;
/** Under this the picture reads as in step, so leave the rate alone. */
const SYNC_TOLERANCE = 0.04;
/** Past this it's a seek or a stall, not drift, so jump rather than ease. */
const SYNC_SEEK_THRESHOLD = 0.5;
const SYNC_MAX_RATE_TRIM = 0.1;
const IDLE_DELAY_MS = 2800;
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The full-screen now-playing view, per the design handoff: the cover
 * blurred across the whole window with a scrim, a layout switch and an
 * Exit pill on top, one of three bodies in the middle (the cover
 * centred, the cover beside the lyrics, or the art itself with the
 * title over it) and the transport along the bottom.
 *
 * Mounted once in AppShell; the store decides whether it shows. It sits
 * under the title bar (the window controls stay reachable) and under
 * every dialog, so Settings can open on top of it. The lyrics column
 * reuses the player card's own `LyricsBody`, only set larger.
 */
export function FullscreenPlayer() {
  const open = useFullscreenStore((s) => s.open);
  const setOpen = useFullscreenStore((s) => s.setOpen);
  const track = usePlaybackStore(currentTrack);

  // Nothing to show once the queue is cleared underneath it.
  useEffect(() => {
    if (open && !track) setOpen(false);
  }, [open, track, setOpen]);

  return (
    <AnimatePresence>
      {open && track ? <FullscreenView key="fullscreen" track={track} /> : null}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome shared by the buttons on the blurred surface                 */
/* ------------------------------------------------------------------ */

/** 34px chip: the design's footer button, on the full-screen surface.
 *  Colours spelled as `[color:…]` so tailwind-merge can pair them with
 *  the button's own text colour and let these win. */
const chip =
  "size-[34px] rounded-[9px] bg-w080 text-[color:var(--fs-txt2)] hover:bg-w160 hover:text-[color:var(--fs-title)] [&_svg]:size-4";

/** The transport's outer pair (shuffle / repeat), 40px, tinted when on. */
const sideButton = (on: boolean) =>
  cn(
    "size-10 rounded-[11px] transition-colors duration-[140ms] hover:bg-w140 [&_svg]:size-[19px]",
    on
      ? "bg-[rgba(var(--acc1rgb),0.16)] text-acc1 hover:text-acc1"
      : "text-(--fs-txt3) hover:text-(--fs-title)",
  );

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

function VideoBackdrop({
  streamId,
  onError,
  onReady,
}: {
  streamId: string;
  onError: () => void;
  onReady: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    (async () => {
      const tier = await getVideoQualityTier();
      const url = await videoStreamUrlFor(streamId, tier);
      if (!cancelled) setSrc(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [streamId]);

  useEffect(() => {
    if (!src) return;
    const check = setTimeout(() => {
      const el = videoRef.current;
      if (!el || typeof el.getVideoPlaybackQuality !== "function") return;
      const q = el.getVideoPlaybackQuality();
      if (q.totalVideoFrames > 60 && q.droppedVideoFrames / q.totalVideoFrames > 0.1) {
        reportPlaybackStutter();
      }
    }, 4000);
    return () => clearTimeout(check);
  }, [src]);

  useEffect(() => {
    if (!src) return;
    let raf: number;
    const tick = () => {
      const el = videoRef.current;
      if (el) {
        const { position, playing } = usePlaybackStore.getState();
        if (playing && el.paused) void el.play().catch(() => {});
        if (!playing && !el.paused) el.pause();
        const target = getAudioClock() ?? position;
        const seekable = !el.duration || target <= el.duration;
        if (el.readyState >= 2 && seekable) {
          const drift = el.currentTime - target;
          const off = Math.abs(drift);
          if (off > SYNC_SEEK_THRESHOLD || !playing) {
            if (off > SYNC_TOLERANCE) el.currentTime = target;
            if (el.playbackRate !== 1) el.playbackRate = 1;
          } else if (off > SYNC_TOLERANCE) {
            // Ease the picture back onto the audio instead of jumping.
            // A seek this small costs a visible hitch and re-drifts within
            // seconds; the rate change is imperceptible on a muted video.
            const trim = Math.max(
              -SYNC_MAX_RATE_TRIM,
              Math.min(SYNC_MAX_RATE_TRIM, drift),
            );
            el.playbackRate = 1 - trim;
          } else if (el.playbackRate !== 1) {
            el.playbackRate = 1;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [src]);

  if (!src) return null;

  return (
    <video
      ref={videoRef}
      key={src}
      src={src}
      muted
      autoPlay
      loop
      playsInline
      onError={onError}
      onLoadedData={onReady}
      className="size-full object-cover"
    />
  );
}

function FullscreenView({ track }: { track: QueueTrack }) {
  const setOpen = useFullscreenStore((s) => s.setOpen);
  const layout = useSettingsStore((s) => s.fullscreenLayout);
  const setLayout = useSettingsStore((s) => s.setFullscreenLayout);
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme === "light";

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
  const toggle = usePlaybackStore((s) => s.toggle);
  const next = usePlaybackStore((s) => s.next);
  const prev = usePlaybackStore((s) => s.prev);
  const seek = usePlaybackStore((s) => s.seek);
  const setShuffle = usePlaybackStore((s) => s.setShuffle);
  const cycleRepeat = usePlaybackStore((s) => s.cycleRepeat);
  const scrub = useScrubStore((s) => s.scrub);
  const setScrub = useScrubStore((s) => s.setScrub);
  const loading = status === "loading" && playing;

  const iTunesCover = useITunesCover(track);
  const sourceRecord = useTrackSourceStore((s) => s.byVideoId[track.videoId]);
  const [videoErrored, setVideoErrored] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    setVideoErrored(false);
  }, [track.videoId]);
  useEffect(() => {
    setVideoReady(false);
  }, [sourceRecord?.video]);

  const setVideoWaiting = useVideoGateStore((s) => s.setWaiting);
  const showVideo =
    sourceRecord?.selected === "video" && !!sourceRecord.video && !videoErrored;

  // Hold the audio while the backdrop is still fetching, so the track
  // doesn't run ahead of the picture. Released on a frame, on an error,
  // on leaving the view, and by the timer regardless: a video that never
  // arrives must not strand playback.
  // Chrome recedes once the mouse settles, the way a fullscreen video
  // player does. Held open while paused: a stopped track means the user
  // is on their way to a control, not watching.
  const idleFade = useSettingsStore((s) => s.fullscreenIdleFade);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  useEffect(() => {
    const wake = () => {
      setIdle(false);
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_DELAY_MS);
    };
    wake();
    const events = ["mousemove", "mousedown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, wake);
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, []);
  const chromeHidden = idle && playing && idleFade;

  const awaitingVideo = showVideo && !videoReady;
  useEffect(() => {
    if (!awaitingVideo) {
      setVideoWaiting(false);
      return;
    }
    setVideoWaiting(true);
    const bail = setTimeout(() => setVideoWaiting(false), VIDEO_WAIT_CEILING_MS);
    return () => {
      clearTimeout(bail);
      setVideoWaiting(false);
    };
  }, [awaitingVideo, setVideoWaiting]);
  const lyricsState = useLyricsView(track);
  // "With lyrics" only means something when there are some. A track the
  // sources came back empty for shows as Centered instead; the setting
  // itself is untouched, so the next track with lyrics gets them again.
  const noLyrics =
    lyricsState.hasTrack && !lyricsState.isLoading && !lyricsState.active;
  const shown: FullscreenLayout =
    layout === "lyrics" && noLyrics ? "cover" : layout;

  // Escape closes the view, unless a dialog, menu or popover on top of
  // it took the key first (Radix marks those keydowns as handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const immersive = shown === "immersive";
  // The cover layouts wash the art out under a heavy blur. Immersive
  // keeps it sharp in the middle and blurs only the top and bottom bands
  // (below), where the chrome and the title sit. Light theme brightens
  // instead of darkening.
  const filter = immersive
    ? light
      ? "saturate(1.05) brightness(1.05)"
      : "saturate(1.18) brightness(0.72)"
    : light
      ? "blur(46px) saturate(0.95) brightness(1.34)"
      : "blur(46px) saturate(1.3) brightness(0.62)";
  const videoFilter = light
    ? "saturate(1.05) brightness(1.05)"
    : "saturate(1.18) brightness(0.72)";

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={0}>
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.985 }}
        transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
        className={cn(
          "fixed inset-0 z-40 flex flex-col overflow-hidden bg-background",
          chromeHidden && "cursor-none",
        )}
      >
        {/* Backdrop: the cover, oversized so the blur has no soft edge.
            An <img> through Thumbnail rather than a CSS background: the
            Google image CDNs answer a request that carries our Referer
            with an HTML stub, and only <img> can send none. */}
        <div
          aria-hidden
          className="absolute inset-[-8%] scale-110 transition-[filter] duration-500"
          style={{ filter }}
        >
          <Thumbnail
            thumbnails={track.thumbnails}
            alt=""
            className="size-full rounded-none bg-transparent"
            targetSize={1024}
            highRes
            overrideHighRes={iTunesCover}
          />
        </div>
        {showVideo && sourceRecord?.video ? (
          <div
            aria-hidden
            className="absolute inset-0 transition-[filter,opacity] duration-500"
            style={{ filter: videoFilter, opacity: videoReady ? 1 : 0 }}
          >
            <VideoBackdrop
              streamId={sourceRecord.video}
              onError={() => setVideoErrored(true)}
              onReady={() => setVideoReady(true)}
            />
          </div>
        ) : null}
        {immersive && !showVideo ? (
          <>
            {/* Blur bands: strongest at the edges, gone by mid-height. */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-1/2 [backdrop-filter:blur(28px)] [mask-image:linear-gradient(to_bottom,black_0%,black_12%,transparent_100%)]"
            />
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-1/2 [backdrop-filter:blur(28px)] [mask-image:linear-gradient(to_top,black_0%,black_12%,transparent_100%)]"
            />
          </>
        ) : null}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: immersive
              ? "linear-gradient(180deg, var(--g9a) 0%, var(--g9b) 34%, var(--g9c) 100%)"
              : "var(--g9d)",
          }}
        />

        {/* The title bar is transparent and stays on top, so the body
            starts below it and the cover runs up behind it. */}
        <div
          className={cn(
            "relative flex min-h-0 flex-1 flex-col px-7 pb-6 pt-[calc(var(--titlebar-h)+8px)] transition-opacity duration-500",
            chromeHidden && "pointer-events-none opacity-0",
          )}
        >
          {/* Top row: layout switch, Exit. */}
          <div className="flex shrink-0 items-center gap-2.5">
            <div
              role="radiogroup"
              aria-label="Full screen layout"
              className="flex gap-0.5 rounded-[10px] border border-w080 bg-w070 p-[3px]"
            >
              {LAYOUTS.map(({ value, label, Icon }) => {
                const on = shown === value;
                return (
                  <Tooltip key={value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={label}
                        onClick={() => setLayout(value)}
                        className={cn(
                          "grid h-7 w-[30px] cursor-pointer place-items-center rounded-[7px] transition-colors duration-[160ms] hover:text-(--fs-title)",
                          on
                            ? "bg-w160 text-(--fs-title) shadow-[0_1px_2px_var(--k300)]"
                            : "text-(--fs-seg)",
                        )}
                      >
                        <Icon />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-[34px] cursor-pointer items-center gap-2 rounded-[9px] bg-w080 px-[13px] text-(--fs-txt2) transition-colors duration-[140ms] hover:bg-w160 hover:text-(--fs-title)"
            >
              <IconArrowsMinimize className="size-[15px]" stroke={1.9} />
              <span className="text-[11px] font-semibold uppercase tracking-[0.09em]">
                Exit fullscreen
              </span>
            </button>
          </div>

          {/* Body, one of three. */}
          {shown === "cover" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[26px] py-2.5">
              <Cover
                track={track}
                override={iTunesCover}
                className="w-[300px] rounded-[14px] shadow-[0_40px_80px_-28px_var(--k900),inset_0_0_0_1px_var(--w140)]"
              />
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="text-[34px] font-bold leading-tight tracking-[-0.03em] text-(--fs-title)">
                  {track.title}
                </span>
                <Subtitle track={track} className="text-[15px]" />
              </div>
            </div>
          ) : null}

          {shown === "lyrics" ? (
            <div className="mx-auto flex min-h-0 w-full max-w-[1020px] flex-1 items-center gap-14 py-3.5">
              <div className="flex w-[340px] shrink-0 flex-col gap-5">
                <Cover
                  track={track}
                  override={iTunesCover}
                  className="w-full rounded-xl shadow-[0_30px_60px_-26px_var(--k900),inset_0_0_0_1px_var(--w140)]"
                />
                <div className="flex min-w-0 flex-col gap-[7px]">
                  <span className="truncate text-[27px] font-bold leading-tight tracking-[-0.025em] text-(--fs-title)">
                    {track.title}
                  </span>
                  <Subtitle track={track} className="truncate text-sm" />
                </div>
              </div>
              {/* Shorter than the cover column on purpose: a few lines
                  either side of the active one, centred on the cover. */}
              <div className="relative h-[min(400px,100%)] min-w-0 flex-1 overflow-hidden">
                <LyricsBody state={lyricsState} large />
              </div>
            </div>
          ) : null}

          {immersive ? (
            <div className="flex min-h-0 flex-1 flex-col justify-end gap-2.5 pb-5 pt-3.5">
              <span className="text-[56px] font-bold leading-[1.02] tracking-[-0.035em] text-(--fs-title) [text-wrap:pretty]">
                {track.title}
              </span>
              <Subtitle track={track} className="text-[17px]" />
            </div>
          ) : null}

          {/* Bottom: progress, then the transport with the side clusters. */}
          <div className="flex shrink-0 flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <span className="w-[38px] shrink-0 font-mono text-xs text-(--fs-time)">
                {formatTime(scrub ?? position)}
              </span>
              <div className="min-w-0 flex-1">
                <ProgressSlider
                  position={position}
                  duration={duration}
                  scrub={scrub}
                  setScrub={setScrub}
                  seek={seek}
                  disabled={duration <= 0}
                />
              </div>
              <span className="w-[38px] shrink-0 text-right font-mono text-xs text-(--fs-time)">
                {formatTime(duration)}
              </span>
            </div>
            <div className="relative flex items-center justify-center gap-3">
              <div className="absolute left-0 top-1/2 flex -translate-y-1/2 items-center gap-2">
                <LikePill track={track} />
                <VolumeControl className={chip} />
              </div>
              <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-2">
                <SourceToggle track={track} />
                <LyricsSourceButton state={lyricsState} className={chip} />
                <QueuePopover className={chip} />
                <PlayerMoreMenu
                  track={track}
                  includeSource={false}
                  className={chip}
                />
              </div>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Shuffle"
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
                className={sideButton(shuffle)}
              >
                <ShuffleIcon className="size-[19px]" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous"
                onClick={prev}
                className={ghostButton}
              >
                <SkipBackIcon className="size-[22px] fill-current" />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                className="mx-1.5 size-16 rounded-full text-white shadow-[0_6px_20px_-4px_rgba(var(--acc1rgb),0.28),inset_0_1px_1px_var(--w220)] transition-[filter,box-shadow] duration-[140ms] hover:brightness-[1.16] hover:shadow-[0_10px_28px_-6px_rgba(var(--acc1rgb),0.36),inset_0_1px_1px_var(--w260)]"
                style={{
                  background:
                    "radial-gradient(circle at 50% 30%, var(--acc5), var(--acc1) 58%)",
                }}
              >
                {/* Sized on the glyphs themselves: the button's own
                    `[&_svg]` rule only yields to an explicit size-*. */}
                {loading ? (
                  <Loader2Icon className="size-[26px] animate-spin" />
                ) : playing ? (
                  <PauseIcon className="size-[26px] fill-current" />
                ) : (
                  <PlayIcon className="ml-0.5 size-[26px] fill-current" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next"
                onClick={next}
                className={ghostButton}
              >
                <SkipForwardIcon className="size-[22px] fill-current" />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={repeatLabel(repeat)}
                    aria-pressed={repeat !== "off"}
                    onClick={cycleRepeat}
                    className={sideButton(repeat !== "off")}
                  >
                    {repeat === "one" ? (
                      <Repeat1Icon className="size-[19px]" />
                    ) : (
                      <RepeatIcon className="size-[19px]" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{repeatLabel(repeat)}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </motion.div>
    </TooltipProvider>
  );
}

/** Prev / next: 44px, bare until hovered. */
const ghostButton =
  "size-11 rounded-xl text-[color:var(--fs-txt)] hover:bg-w140 hover:text-[color:var(--fs-title)]";

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/**
 * The design's like pill: glyph plus "Liked" / "Like", tinted with the
 * accent while liked. Follows Appearance -> Rating buttons the way the
 * row buttons do, so with thumbs on it grows a thumbs-down chip too.
 */
function LikePill({ track }: { track: QueueTrack }) {
  const qc = useQueryClient();
  const both = useSettingsStore((s) => s.ratingButtons === "both");
  const isDisliked = useDislikesStore((s) => !!s.ids[track.videoId]);
  const liked = useQuery({
    queryKey: ["liked-songs"],
    queryFn: () => fetchLikedSongs(),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const isLiked = getLikedIdsSet(liked.data).has(track.videoId);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };
  const LikeIcon = both ? ThumbsUpIcon : HeartIcon;

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-pressed={isLiked}
        onClick={() =>
          run(() =>
            toggleLiked({
              queryClient: qc,
              videoId: track.videoId,
              wasLiked: isLiked,
              track,
            }),
          )
        }
        className={cn(
          "flex h-[34px] cursor-pointer items-center gap-[7px] rounded-[9px] px-[13px] text-[12.5px] font-semibold tracking-[-0.005em] transition-colors duration-[140ms] hover:bg-w140",
          isLiked
            ? "bg-[rgba(var(--acc1rgb),0.14)] text-acc1 hover:bg-[rgba(var(--acc1rgb),0.2)]"
            : "bg-w070 text-[color:var(--fs-txt2)]",
        )}
      >
        <LikeIcon
          className={cn("size-4", isLiked && "fill-current")}
          strokeWidth={1.9}
        />
        {isLiked ? "Liked" : "Like"}
      </button>
      {both ? (
        <button
          type="button"
          disabled={busy}
          aria-label={isDisliked ? "Remove dislike" : "Dislike"}
          aria-pressed={isDisliked}
          onClick={() =>
            run(() =>
              toggleDisliked({
                queryClient: qc,
                videoId: track.videoId,
                wasDisliked: isDisliked,
                wasLiked: isLiked,
                track,
              }),
            )
          }
          className={cn(
            "grid size-[34px] cursor-pointer place-items-center rounded-[9px] transition-colors duration-[140ms] hover:bg-w160",
            isDisliked
              ? "bg-w160 text-[color:var(--fs-title)]"
              : "bg-w080 text-[color:var(--fs-txt2)]",
          )}
        >
          <ThumbsDownIcon
            className={cn("size-4", isDisliked && "fill-current")}
            strokeWidth={1.9}
          />
        </button>
      ) : null}
    </>
  );
}

function Cover({
  track,
  override,
  className,
}: {
  track: QueueTrack;
  override: string | null;
  className?: string;
}) {
  return (
    <div className={cn("relative isolate aspect-square shrink-0", className)}>
      <Thumbnail
        thumbnails={track.thumbnails}
        alt={track.title}
        className="pointer-events-none size-full rounded-[inherit]"
        targetSize={1024}
        highRes
        overrideHighRes={override}
      />
      <ArtworkOutline className="rounded-[inherit]" />
    </div>
  );
}

/**
 * Artist line, with the album after a dot when the track has one. Both
 * link through like the player card's; following one lands on a page
 * under this view, so the view closes as the link is taken.
 */
function Subtitle({
  track,
  className,
}: {
  track: QueueTrack;
  className?: string;
}) {
  const setOpen = useFullscreenStore((s) => s.setOpen);
  return (
    <span
      className={cn("text-(--fs-sub)", className)}
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) setOpen(false);
      }}
    >
      <ArtistLinks artists={track.artists} fallback={track.subtitle ?? ""} />
      {track.album ? (
        <>
          {track.artists?.length || track.subtitle ? " · " : null}
          {track.albumId ? (
            <EntityLink to="/album/$id" id={track.albumId} event="nav:album">
              {track.album}
            </EntityLink>
          ) : (
            track.album
          )}
        </>
      ) : null}
    </span>
  );
}

/* The layout switch's three glyphs, drawn as in the design. */

function CoverGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="9.5"
        y="8"
        width="5"
        height="5"
        rx="1.2"
        fill="currentColor"
        stroke="none"
      />
      <path d="M9 16h6" strokeLinecap="round" />
    </svg>
  );
}

function LyricsGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <rect
        x="6"
        y="8"
        width="4.5"
        height="4.5"
        rx="1.2"
        fill="currentColor"
        stroke="none"
      />
      <path d="M13 9h5M13 12h5M13 15h3" strokeLinecap="round" />
    </svg>
  );
}

function ImmersiveGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        fill="currentColor"
        fillOpacity="0.34"
      />
      <path d="M6.5 16h7M6.5 12.8h4" strokeLinecap="round" />
    </svg>
  );
}

const LAYOUTS: {
  value: FullscreenLayout;
  label: string;
  Icon: () => React.JSX.Element;
}[] = [
  { value: "cover", label: "Centered", Icon: CoverGlyph },
  { value: "lyrics", label: "With lyrics", Icon: LyricsGlyph },
  { value: "immersive", label: "Immersive art", Icon: ImmersiveGlyph },
];
