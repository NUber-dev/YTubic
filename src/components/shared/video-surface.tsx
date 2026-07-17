import { useLayoutEffect, useRef } from "react";
import { getVideoSurfaceElement } from "@/lib/audio-engine";
import { usePlaybackStore } from "@/lib/store/playback";
import {
  useSettingsStore,
  type VideoQuality,
} from "@/lib/store/settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Adopts the audio engine's singleton <video> element as a visible
 * surface. The element lives detached for audio-only streams and keeps
 * playing while unmounted; mounting it here only makes its frames
 * visible, playback ownership stays with the engine.
 *
 * Reparent-safe: two surfaces can overlap across a mount boundary (the
 * fullscreen stage opening over the side panel). Adoption is a plain
 * appendChild, which MOVES the element without re-running media
 * selection, so position and playback survive. Cleanup only detaches
 * when this host still owns the element, so an older surface unmounting
 * can't yank it out of the newer one. Sizing lives on the host via a
 * child selector, never on el.className, for the same ownership reason.
 * useLayoutEffect keeps the detach→attach handoff inside one paint.
 */
export function VideoSurface({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const el = getVideoSurfaceElement();
    if (!host || !el) return;
    host.appendChild(el);
    return () => {
      if (el.parentElement === host) el.remove();
    };
  }, []);
  return (
    <div
      ref={hostRef}
      className={cn(
        "[&>video]:block [&>video]:size-full [&>video]:object-contain",
        className,
      )}
    />
  );
}

const QUALITY_OPTIONS: VideoQuality[] = [2160, 1440, 1080, 720, 480, 360];

function qualityLabel(q: VideoQuality): string {
  if (q === 2160) return "4K (VP9)";
  if (q === 1440) return "1440p (VP9)";
  if (q === 1080) return "1080p";
  return `${q}p`;
}

/**
 * Live "1080p" badge over a video surface, doubling as the quality
 * picker (YouTube-style). The label is the companion element's REAL
 * decoded height, not the requested cap, so a video with nothing above
 * 480p reads 480p even on the Auto setting. Picking a quality re-caps
 * the vonly stream; the audio master never rebuffers, so the swap is
 * gapless apart from the frames reloading.
 */
export function VideoQualityBadge({ className }: { className?: string }) {
  const height = usePlaybackStore((s) => s.streamVideoHeight);
  const quality = useSettingsStore((s) => s.videoQuality);
  const setQuality = useSettingsStore((s) => s.setVideoQuality);
  if (!height) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Video quality"
          title={
            height < quality * 0.9
              ? `this video tops out at ${height}p`
              : undefined
          }
          className={cn(
            "pointer-events-auto rounded-full border border-hairline bg-black/50 px-2 py-0.5 text-xs font-semibold text-white/90 backdrop-blur-md transition-colors hover:bg-black/70",
            className,
          )}
        >
          {height}p
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {QUALITY_OPTIONS.map((q) => (
          <DropdownMenuItem
            key={q}
            onClick={() => setQuality(q)}
            className="flex items-center justify-between"
          >
            <span>{qualityLabel(q)}</span>
            {quality === q ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {/* The setting is a CAP, the badge is reality. When they differ
            (a 2007 MV or an art track has no 4K), say so right in the
            menu instead of looking like the setting silently failed. */}
        {height < quality * 0.9 ? (
          <div className="border-t border-hairline px-2 py-1.5 text-xs text-muted-foreground">
            this video tops out at {height}p
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
