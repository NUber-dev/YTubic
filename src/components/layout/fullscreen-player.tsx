import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  accentStyleFor,
  formatTime,
  repeatLabel,
  useAccentColor,
  useITunesCover,
  useLatchedCover,
} from "@/components/layout/player-bar";
import {
  Thumbnail,
  thumbnailUrlsBySize,
} from "@/components/shared/thumbnail";
import { usePlaybackStore, currentTrack } from "@/lib/store/playback";
import { getMediaElement } from "@/lib/audio-engine";
import { cn, artistLineFromSubtitle } from "@/lib/utils";

// Where the active line rests in the fullscreen lyric pane. Apple
// Music parks it near the TOP of the pane — past lines exit
// immediately and the visible window below is all upcoming text — so
// this is much higher than the inline panel's just-below-center feel.
const FULLSCREEN_LYRICS_VIEWPORT_RATIO = 0.22;

/**
 * Ambient backdrop with the same two-slot cross-fade BackgroundCover
 * (app-shell) uses. A keyed <img> here remounted on every URL change —
 * track switches and the mid-track thumbnail→iTunes-cover upgrade both
 * dropped the backdrop to the black scrim for a frame, which read as a
 * blink. Failed loads bubble up so the caller can advance its
 * candidate list.
 */
function AmbientBackdrop({
  url,
  onError,
}: {
  url: string | null;
  onError: (failedUrl: string) => void;
}) {
  const [slotA, setSlotA] = useState<string | null>(null);
  const [slotB, setSlotB] = useState<string | null>(null);
  const [active, setActive] = useState<"A" | "B">("A");

  useEffect(() => {
    if (!url) return;
    const currentSlot = active === "A" ? slotA : slotB;
    if (url === currentSlot) return;
    if (active === "A") {
      setSlotB(url);
      setActive("B");
    } else {
      setSlotA(url);
      setActive("A");
    }
  }, [url, active, slotA, slotB]);

  const baseClass =
    "pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-[80px] saturate-150 transition-opacity duration-700 ease-out";

  return (
    <>
      {slotA && (
        <img
          src={slotA}
          alt=""
          aria-hidden
          onError={() => onError(slotA)}
          className={baseClass}
          style={{ opacity: active === "A" ? 1 : 0 }}
        />
      )}
      {slotB && (
        <img
          src={slotB}
          alt=""
          aria-hidden
          onError={() => onError(slotB)}
          className={baseClass}
          style={{ opacity: active === "B" ? 1 : 0 }}
        />
      )}
    </>
  );
}

/**
 * Two-slot crossfade for the foreground artwork. The art used to swap
 * hard twice per track change — once when the queue flipped (the new
 * thumbnail paints instantly) and again when the iTunes high-res
 * upgrade landed — which read as a flash against the slower ambient
 * crossfade behind it. The old art holds underneath while the new one
 * fades in.
 */
function CrossfadeArt({
  slotKey,
  className,
  children,
}: {
  slotKey: string;
  className?: string;
  children: ReactNode;
}) {
  const prevRef = useRef<{ key: string; node: ReactNode } | null>(null);
  const lastRef = useRef<{ key: string; node: ReactNode } | null>(null);
  const [, force] = useState(0);
  if (lastRef.current && lastRef.current.key !== slotKey) {
    prevRef.current = lastRef.current;
  }
  lastRef.current = { key: slotKey, node: children };
  useEffect(() => {
    if (!prevRef.current) return;
    const t = setTimeout(() => {
      prevRef.current = null;
      force((x) => x + 1);
    }, 450);
    return () => clearTimeout(t);
  }, [slotKey]);
  return (
    <div className={cn("relative", className)}>
      {prevRef.current ? (
        <div aria-hidden className="absolute inset-0">
          {prevRef.current.node}
        </div>
      ) : null}
      <motion.div
        key={slotKey}
        initial={{ opacity: prevRef.current ? 0 : 1 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        {lastRef.current.node}
      </motion.div>
    </div>
  );
}

/**
 * Adopts the audio engine's singleton <video> element as a visible
 * surface. The element lives detached for audio-only streams and keeps
 * playing when unmounted — mounting it here only makes its frames
 * visible; playback ownership stays with the engine.
 */
function VideoSurface({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    const el = getMediaElement();
    if (!host || !el) return;
    el.className = "h-full w-full object-contain";
    host.appendChild(el);
    return () => {
      el.className = "";
      el.remove();
    };
  }, []);
  return <div ref={hostRef} className={className} />;
}

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
  const streamKind = usePlaybackStore((s) => s.streamKind);
  const iTunesCover = useLatchedCover(track, useITunesCover(track));
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

  // Ordered art candidates: the local iTunes cover first (served from our own
  // loopback server, so both the webview <img> and the Rust accent fetch read
  // it reliably), then every YouTube thumbnail largest→smallest. The ambient
  // <img> and the accent both walk this list, dropping to the next candidate
  // when one fails, so a 404 on the largest variant no longer leaves a black
  // backdrop and a red accent. The sharp foreground art still prefers iTunes.
  const artCandidates = useMemo(
    () =>
      [iTunesCover, ...thumbnailUrlsBySize(track?.thumbnails ?? [])].filter(
        (u): u is string => Boolean(u),
      ),
    [iTunesCover, track?.thumbnails],
  );
  const accent = useAccentColor(artCandidates);
  const [failedArt, setFailedArt] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setFailedArt(new Set());
  }, [track?.videoId]);
  const backdropUrl = artCandidates.find((u) => !failedArt.has(u)) ?? null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Take over the whole screen while the immersive view is open — native
  // macOS fullscreen (its own Space, menu bar + dock hidden), the same
  // thing the green button gives — and hand it back on close. Without this
  // the overlay only fills the app window, leaving the menu bar and dock
  // showing, which reads as a half-baked "fullscreen".
  useEffect(() => {
    const win = getCurrentWindow();
    void win.setFullscreen(true).catch(() => {});
    return () => {
      void win.setFullscreen(false).catch(() => {});
    };
  }, []);

  // Queue emptied while open (clear queue from the tray, last track
  // removed) means nothing to show, so fold back to the normal layout.
  useEffect(() => {
    if (!track) onClose();
  }, [track, onClose]);

  if (!track) return null;

  const loading = status === "loading" && playing;
  const accentStyle = accentStyleFor(accent);
  const artistLine = track.artists?.length
    ? track.artists.map((a) => a.name).join(", ")
    : artistLineFromSubtitle(track.subtitle) || (track.subtitle ?? "");

  // Seek + transport cluster. Rendered in one of two slots: pinned to
  // the window bottom when the lyrics pane fills the stage, or stacked
  // directly under the art+meta column when there are no lyrics — a
  // lyric-less track otherwise strands the controls at the bottom with
  // a dead band between them and the title (Apple Music groups art,
  // meta and controls as one centered unit in that state).
  const controls = (
    <>
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
        {/* Remaining, not total — the Apple Music fullscreen reading. */}
        <span>
          -{formatTime(Math.max(0, knownDuration - (scrub ?? position)))}
        </span>
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
          className="size-12 rounded-full bg-brand text-[var(--player-accent-fg,white)] hover:bg-brand/90"
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
      </div>
      {/* Persistent volume slider under the transport, Apple Music
          style — the old absolute-right vertical popover belonged to
          the pinned-strip layout. */}
      <div className="mt-1 px-1">
        <VolumeControl direction="inline" />
      </div>
    </>
  );

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
        <AmbientBackdrop
          url={backdropUrl}
          onError={(failed) =>
            setFailedArt((prev) => new Set(prev).add(failed))
          }
        />
        {/* Light scrim only — Apple Music's fullscreen keeps the blurred
            art vivid and bright; a heavy black wash buried it. */}
        <div aria-hidden className="absolute inset-0 bg-black/30" />
        {/* On notched MacBooks a native-fullscreen Space reserves a black
            band beside the camera housing that apps cannot paint. Fade
            the backdrop to black toward the top edge so that band blends
            into the scene instead of reading as a hard cut (Apple Music
            gets this for free by having black chrome). */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/60 via-black/25 to-transparent"
        />
        <div aria-hidden className="bg-cover-noise absolute inset-0" />

        <div className="relative z-10 flex h-full min-h-0 flex-col px-[6vw] pt-(--titlebar-h)">
          {/* Exit chevron floats top-right instead of occupying a flex
              row, so the stage really is the full height and a
              lyric-less layout centers as one unit. */}
          <div className="absolute right-[2vw] top-[calc(var(--titlebar-h)+0.75rem)] z-20">
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
            {/* Player column — Apple Music's fullscreen groups art,
                meta, seek, transport and volume as one unit on the
                left with the lyrics filling the rest of the stage.
                Without lyrics the same column simply centers alone. */}
            <div
              className={cn(
                "flex min-w-0 shrink-0 flex-col",
                showLyrics ? "w-[min(32vw,50vh)]" : "w-[min(38vw,56vh)]",
              )}
            >
              {streamKind === "video" ? (
                <VideoSurface className="aspect-video w-full overflow-hidden rounded-lg border border-hairline bg-black shadow-2xl" />
              ) : (
                <CrossfadeArt
                  className="w-full"
                  slotKey={`${track.videoId}:${iTunesCover ? "hi" : "lo"}`}
                >
                  <Thumbnail
                    thumbnails={track.thumbnails}
                    alt={track.title}
                    className="aspect-square w-full rounded-lg border border-hairline object-cover shadow-2xl"
                    targetSize={1024}
                    highRes
                    overrideHighRes={iTunesCover}
                  />
                </CrossfadeArt>
              )}
              <div
                className={cn(
                  "mt-4 flex min-w-0 flex-col gap-0.5",
                  !showLyrics && "items-center text-center",
                )}
              >
                <span className="max-w-full truncate text-xl font-semibold">
                  {track.title}
                </span>
                <span className="max-w-full truncate text-sm text-muted-foreground">
                  {artistLine}
                </span>
              </div>
              <div className="mt-3 flex w-full flex-col gap-2">{controls}</div>
            </div>
            {/* Bump the line size for the big canvas. The descendant
                selector outweighs the component's own `text-lg`, so the
                shared lyrics component stays untouched. */}
            {showLyrics ? (
              <div className="flex h-[min(66vh,46rem)] w-[min(44rem,44vw)] min-w-0 flex-col [&_.lyrics-line]:my-0 [&_.lyrics-line]:py-3 [&_.lyrics-line]:text-4xl [&_.lyrics-line]:font-bold [&_.lyrics-line]:leading-[1.15] [&_.lyrics-plain]:text-3xl [&_.lyrics-plain]:font-bold [&_.lyrics-plain]:leading-snug [&_.lyrics-plain]:text-foreground/85">
                <LyricsBody
                  state={lyricsState}
                  viewportRatio={FULLSCREEN_LYRICS_VIEWPORT_RATIO}
                />
              </div>
            ) : null}
          </div>
        </div>
      </motion.div>
    </TooltipProvider>,
    document.body,
  );
}
