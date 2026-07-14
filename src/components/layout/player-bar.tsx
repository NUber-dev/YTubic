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
  Maximize2Icon,
  MusicIcon,
  VideoIcon,
} from "lucide-react";
import { QueueBody, QueueToggleButton } from "@/components/layout/queue-panel";
import { FullscreenPlayer } from "@/components/layout/fullscreen-player";
import {
  LyricsBody,
  LyricsSourceButton,
  useLyricsView,
} from "@/components/layout/lyrics-view";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { Thumbnail, thumbnailUrlsBySize } from "@/components/shared/thumbnail";
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
  const albumKey = track?.album ?? "";

  useEffect(() => {
    setUrl(null);
    if (!artistKey || !titleKey) return;
    let cancelled = false;
    (async () => {
      const itunes = await lookupITunesCover(
        artistKey,
        titleKey,
        albumKey || undefined,
      );
      if (cancelled || !itunes) return;
      const cached = await cacheCoverToDisk(itunes);
      if (cancelled) return;
      setUrl(cached);
    })();
    return () => {
      cancelled = true;
    };
  }, [artistKey, titleKey, albumKey]);

  return url;
}

/**
 * Gate the iTunes cover upgrade to the first moments of a track. The
 * YT thumbnail and the iTunes cover are sometimes entirely different
 * artworks (Russ "3:15" — yellow digits vs the beige violin), so a
 * late-arriving upgrade visibly REPLACED the art (and backdrop and
 * accent with it) mid-track. If the lookup resolves fast (memory/disk
 * cache — every repeat play), it applies from the first paint; if it
 * misses the window, this play keeps the YT art and the upgrade wins
 * from the next play onward. Art never changes mid-track.
 */
const COVER_LATCH_WINDOW_MS = 450;

export function useLatchedCover(
  track: QueueTrack | undefined,
  cover: string | null,
): string | null {
  const [latched, setLatched] = useState<string | null>(null);
  const deadlineRef = useRef(0);
  useEffect(() => {
    deadlineRef.current = performance.now() + COVER_LATCH_WINDOW_MS;
    setLatched(null);
  }, [track?.videoId]);
  useEffect(() => {
    if (!cover) return;
    if (performance.now() <= deadlineRef.current) setLatched(cover);
  }, [cover]);
  return latched;
}

/**
 * Vibrant accent hex pulled from the cover art by a Rust command (a webview
 * canvas read taints on the CORS-less art CDNs, so it's done server-side).
 * Returns null until it resolves, so callers keep the brand default until
 * then. Shared by the compact player and the fullscreen view so the accent
 * matches across both. Pass the YouTube thumbnail rather than the cached
 * iTunes cover: it's downscaled server-side anyway, and it's always
 * reachable, so the accent never falls back to red just because the local
 * cover lagged behind.
 */
// Mirrors the Rust ACCENT_FALLBACK. Used when the accent fetch itself fails
// (network/host reject) so the UI shows a neutral grey rather than snapping
// back to brand red — red is reserved for tracks with no artwork at all.
const ACCENT_NEUTRAL = "#71717A";

/**
 * Near-greyscale or extreme-lightness accents — white, grey, or black
 * album art — tint the seek fill and play button into the same grey as
 * the track behind them, which reads as a broken bar (Gulaab). Apple
 * Music renders such covers with plain white controls; do the same.
 */
function legibleAccent(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const rl = r / 255;
  const gl = g / 255;
  const bl = b / 255;
  const max = Math.max(rl, gl, bl);
  const min = Math.min(rl, gl, bl);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
  if (s < 0.22 || l > 0.82) return "#ffffff";
  // The backdrop is the SAME art the accent came from, so a dark accent
  // can never contrast with it (red fill on red cover). Lift dark
  // accents in HSL — lightness up, saturation floored — so the fill
  // reads on top of the art while staying inside its color family.
  // (A plain blend toward white desaturated instead: Starboy's dark
  // red turned pink, matching nothing on the cover.)
  const lum = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  if (lum < 0.5) {
    let h = 0;
    if (d !== 0) {
      if (max === rl) h = ((gl - bl) / d + (gl < bl ? 6 : 0)) / 6;
      else if (max === gl) h = ((bl - rl) / d + 2) / 6;
      else h = ((rl - gl) / d + 4) / 6;
    }
    const s2 = Math.max(s, 0.65);
    const l2 = 0.58;
    const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2;
    const p2 = 2 * l2 - q;
    const channel = (t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p2 + (q - p2) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p2 + (q - p2) * (2 / 3 - t) * 6;
      return p2;
    };
    r = Math.round(channel(h + 1 / 3) * 255);
    g = Math.round(channel(h) * 255);
    b = Math.round(channel(h - 1 / 3) * 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }
  return hex;
}

/** Black or white for icons sitting ON the accent fill. A plain
 *  luminance threshold is enough here — accents are either vivid
 *  (white icon) or the white clamp above (black icon). */
function accentForeground(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum =
    (0.2126 * ((n >> 16) & 255) +
      0.7152 * ((n >> 8) & 255) +
      0.0722 * (n & 255)) /
    255;
  return lum > 0.6 ? "#18181b" : "#ffffff";
}

export function useAccentColor(
  urls: ReadonlyArray<string | null | undefined>,
): string | null {
  // Key on the actual candidate set (a stable string), not the array
  // identity, which changes every render.
  const key = urls.filter((u): u is string => Boolean(u)).join("\n");
  const [accent, setAccent] = useState<string | null>(null);
  useEffect(() => {
    const candidates = key.split("\n").filter(Boolean);
    if (candidates.length === 0) {
      setAccent(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Walk the candidates (iTunes cover first, then thumbnails largest→
      // smallest) and take the first the Rust side can actually fetch. The
      // single largest thumbnail sometimes 404s; without this the accent
      // just fell back to red instead of trying the next size.
      for (const url of candidates) {
        try {
          const hex = await invoke<string>("dominant_accent_color", { url });
          if (!cancelled) setAccent(legibleAccent(hex));
          return;
        } catch {
          /* try the next candidate */
        }
      }
      if (!cancelled) setAccent(ACCENT_NEUTRAL);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);
  return accent;
}

/**
 * Remap the brand tokens to an extracted accent for a subtree: the seek
 * fill (`bg-primary`), play button (`bg-brand`), and active shuffle/repeat
 * icons (`text-brand`) all follow. Returns undefined (no override) until
 * the accent resolves, so the brand default shows meanwhile.
 */
export function accentStyleFor(accent: string | null): CSSProperties | undefined {
  return accent
    ? ({
        "--player-accent": accent,
        // Icon color for controls filled with the accent (play button):
        // near-black on light accents (the white-clamped ones above),
        // white on everything else. Consumers use
        // `text-[var(--player-accent-fg,white)]` so the brand default
        // keeps its white icon before the accent resolves.
        "--player-accent-fg": accentForeground(accent),
        "--brand": "var(--player-accent)",
        "--primary": "var(--player-accent)",
      } as CSSProperties)
    : undefined;
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
    // A video-native track already IS the video: its own stream carries
    // the audio too, so song mode plays its own id's audio and video mode
    // its own mp4. Never blind-search for a different clip, which used to
    // return an unrelated video. Genuine song<->video counterparts are
    // seeded from InnerTube data and taken by the cachedAlt path above.
    if (track.kind === "video") {
      setAlternate(track.videoId, target, track.videoId);
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
        thumbless
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
  /** "horizontal"/"vertical" are hover-popover variants for the
   *  compact bars; "inline" renders a persistent icon+slider row
   *  (the Apple Music fullscreen volume). */
  direction?: "horizontal" | "vertical" | "inline";
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

  if (direction === "inline") {
    return (
      <div
        className="flex w-full items-center gap-2.5"
        onWheel={(e) => {
          const delta = e.deltaY < 0 ? 0.05 : -0.05;
          const next = Math.max(0, Math.min(1, volume + delta));
          setVolume(next);
        }}
      >
        <button
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={toggleMute}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
        <Slider
          value={[pct]}
          max={100}
          step={1}
          className="[&_[data-slot=slider-track]]:bg-white/20"
          aria-label="Volume"
          onValueChange={([v]) => setVolume(v / 100)}
        />
        <Volume2Icon aria-hidden className="size-4 text-muted-foreground" />
      </div>
    );
  }

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
  const [fullscreen, setFullscreen] = useState(false);
  const iTunesCover = useLatchedCover(track, useITunesCover(track));
  // Accent for the whole player surface, pulled from the cover art (same
  // source the fullscreen view uses) so the seek fill, play button, and
  // active toggles match the art here too instead of staying brand red.
  const accent = useAccentColor([
    iTunesCover,
    ...thumbnailUrlsBySize(track?.thumbnails ?? []),
  ]);
  const accentStyle = accentStyleFor(accent);
  const lyricsState = useLyricsView(track);
  // The cover doubles as a drag handle for layout switching. In the
  // floating window the OS title bar already owns drag, so we don't
  // attach our own handler there.
  const { onPointerDown: onCoverPointerDown } = usePlayerCoverDrag({
    enabled: variant !== "floating",
  });

  const hasTrack = !!track;
  // The <audio> element reports its own duration late (and sometimes as
  // Infinity) for the progressive yt-dlp stream, so `duration` sits at 0
  // for the first seconds of a track. Fall back to the browse metadata
  // duration so the seek bar scales correctly and the total time isn't
  // stuck at 0:00 with a stray played-fill dot pinned at the far left.
  const knownDuration = duration > 0 ? duration : (track?.duration ?? 0);
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
    <aside className={wrapperClass} style={accentStyle}>
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
            duration={knownDuration}
            scrub={scrub}
            setScrub={setScrub}
            seek={seek}
            disabled={!hasTrack || knownDuration <= 0}
          />
          <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
            <span>{formatTime(scrub ?? position)}</span>
            <span>{formatTime(knownDuration)}</span>
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
                so the whole non-queue body crossfades as one unit.
                When the lookup resolves with nothing, the space shows
                the queue instead of sitting empty under a lone
                "No lyrics found." — same QueueBody the queue toggle
                uses, minus its close button. */}
            {lyricsState.hasTrack &&
            !lyricsState.isLoading &&
            !lyricsState.active ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <QueueBody />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col px-3">
                <LyricsBody state={lyricsState} />
              </div>
            )}
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
          {/* No expand in the floating window: a "full screen" view of a
              350px window isn't one, and the main window already offers
              the real thing. */}
          {variant !== "floating" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Full screen"
                  disabled={!hasTrack}
                  onClick={() => setFullscreen(true)}
                >
                  <Maximize2Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Full screen</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {track && <SourceToggle track={track} />}
          <PlayerMoreMenu track={track} includeSource={false} />
        </div>
      </div>
    </aside>
    {fullscreen ? (
      <FullscreenPlayer onClose={() => setFullscreen(false)} />
    ) : null}
    </TooltipProvider>
  );
}
