import { useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  MoreVerticalIcon,
  MusicIcon,
  VideoIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  NewPlaylistDialog,
  TrackMenuItems,
  dropPrimitives,
  useTrackMenuController,
} from "@/components/shared/track-context-menu";
import { findAlternateVideoId } from "@/lib/innertube/alternate-source";
import { isFloatingPlayerWindow } from "@/lib/floating-player";
import {
  useTrackSourceStore,
  type SourceKind,
} from "@/lib/store/track-source";
import type { QueueTrack } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  track: QueueTrack | undefined;
  /**
   * When `true` (default), the menu prepends a Song/Video radio
   * group. The right-card layout already has a segmented source
   * toggle inline so it passes `false` to avoid duplicating it; the
   * bottom bar has no inline toggle and relies on this menu for it.
   */
  includeSource?: boolean;
  align?: "start" | "end";
  side?: "top" | "right" | "bottom" | "left";
};

/**
 * Triple-dot overflow menu for the player surfaces. Wraps the same
 * `TrackMenuItems` block used by the right-click context menu on
 * track rows, so the actions (Play next, Add to queue, Start radio,
 * Like / Remove from liked, Add to playlist, Go to artist) stay in
 * sync between every entry point.
 *
 * Splits into a main-window branch (uses `useNavigate` directly) and
 * a floating-window branch (emits a Tauri event so the main window
 * handles routing — the floating window has no router context, so
 * calling `useNavigate` there would throw). The branch is fixed at
 * module-load time per window so React's rules-of-hooks aren't
 * violated.
 */
export function PlayerMoreMenu(props: Props) {
  return isFloatingPlayerWindow() ? (
    <PlayerMoreMenuFloating {...props} />
  ) : (
    <PlayerMoreMenuMain {...props} />
  );
}

function PlayerMoreMenuMain(props: Props) {
  const navigate = useNavigate();
  return (
    <PlayerMoreMenuInner
      {...props}
      onGoToArtist={(id) =>
        navigate({ to: "/artist/$id", params: { id } })
      }
    />
  );
}

function PlayerMoreMenuFloating(props: Props) {
  return (
    <PlayerMoreMenuInner
      {...props}
      onGoToArtist={(id) => {
        void emit("nav:artist", { id });
        // Bring the main window to the front so the user actually
        // sees the page they just navigated to.
        void invoke("focus_main_window").catch(() => {
          /* command might not be registered in older builds */
        });
      }}
    />
  );
}

/**
 * `useTrackMenuController` runs unconditionally even when there's
 * no active track — it owns React Query queries we can't conditionally
 * skip without violating the rules of hooks. We feed it a stub
 * `ShelfItem` in that case and disable the trigger button instead.
 */
function PlayerMoreMenuInner({
  track,
  includeSource = true,
  align = "end",
  side = "top",
  onGoToArtist,
}: Props & { onGoToArtist: (artistId: string) => void }) {
  const item: ShelfItem = track
    ? {
        kind: "song",
        id: track.videoId,
        title: track.title,
        thumbnails: track.thumbnails,
        artists: track.artists,
        album: track.album,
        duration: track.duration,
      }
    : { kind: "song", id: "", title: "", thumbnails: [] };

  const controller = useTrackMenuController(item);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More"
                disabled={!track}
              >
                <MoreVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align={align} side={side} className="w-56">
          {track ? (
            <>
              {includeSource ? (
                <>
                  <DropdownMenuLabel>Source</DropdownMenuLabel>
                  <SourceMenuItems track={track} />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <TrackMenuItems
                item={item}
                controller={controller}
                primitives={dropPrimitives}
                onGoToArtist={onGoToArtist}
              />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {track ? (
        <NewPlaylistDialog
          open={controller.newPlaylistOpen}
          onOpenChange={controller.setNewPlaylistOpen}
          defaultTitle={item.title}
          videoId={item.id}
        />
      ) : null}
    </>
  );
}

/**
 * Source-kind switcher rendered as menu items (rather than the
 * segmented control used in the right card). Same on-demand
 * `findAlternateVideoId` lookup — the menu form is just less wide.
 */
function SourceMenuItems({ track }: { track: QueueTrack }) {
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
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void switchTo("song");
        }}
        disabled={busy !== null}
      >
        {busy === "song" ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <MusicIcon className="size-4" />
        )}
        <span className="flex-1">Song</span>
        {selected === "song" ? <CheckIcon className="size-4" /> : null}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void switchTo("video");
        }}
        disabled={busy !== null}
      >
        {busy === "video" ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <VideoIcon className="size-4" />
        )}
        <span className="flex-1">Video</span>
        {selected === "video" ? <CheckIcon className="size-4" /> : null}
      </DropdownMenuItem>
    </>
  );
}
