import { useState, type ReactNode } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  NewPlaylistDialog,
  TrackMenuItems,
  ctxPrimitives,
  useTrackMenuController,
} from "@/components/shared/track-context-menu";
import {
  getHighResVariant,
  pickHighResThumbnail,
} from "@/components/shared/thumbnail";
import { downloadCover, lookupITunesCover } from "@/lib/cover-art";
import { isFloatingPlayerWindow } from "@/lib/floating-player";
import type { QueueTrack } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  track: QueueTrack | undefined;
  children: ReactNode;
};

/**
 * Right-click menu for the now-playing cover art. Reuses the same
 * `TrackMenuItems` block as track rows and the ⋯ player menu, so the
 * cover offers everything the overflow menu does, plus a
 * "Download cover" item that only makes sense on the artwork itself.
 *
 * Same main-window / floating-window split as `PlayerMoreMenu`: the
 * floating player window has no router, so `useNavigate` may only be
 * called on the main-window branch. The branch is fixed per window at
 * module-load time, so hook order stays stable.
 */
export function PlayerCoverMenu(props: Props) {
  return isFloatingPlayerWindow() ? (
    <PlayerCoverMenuFloating {...props} />
  ) : (
    <PlayerCoverMenuMain {...props} />
  );
}

function PlayerCoverMenuMain(props: Props) {
  const navigate = useNavigate();
  return (
    <PlayerCoverMenuInner
      {...props}
      onGoToArtist={(id) => navigate({ to: "/artist/$id", params: { id } })}
    />
  );
}

function PlayerCoverMenuFloating(props: Props) {
  return (
    <PlayerCoverMenuInner
      {...props}
      onGoToArtist={(id) => {
        void emit("nav:artist", { id });
        void invoke("focus_main_window").catch(() => {
          /* command might not be registered in older builds */
        });
      }}
    />
  );
}

function PlayerCoverMenuInner({
  track,
  children,
  onGoToArtist,
}: Props & { onGoToArtist: (artistId: string) => void }) {
  // Same stub-item dance as `PlayerMoreMenu`: the controller owns React
  // Query hooks that can't be skipped when nothing is playing.
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
  const [saving, setSaving] = useState(false);

  if (!track) return <>{children}</>;

  const artistLine = track.artists?.length
    ? track.artists.map((a) => a.name).join(", ")
    : (track.subtitle ?? "");

  const saveCover = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Highest quality first: iTunes studio art (3000×3000 when it
      // exists, already cached from the player's own lookup), then the
      // upgraded YT URL, then whatever the API shipped.
      const itunes = await lookupITunesCover(artistLine, track.title);
      const largest = pickHighResThumbnail(track.thumbnails);
      const path = await downloadCover(
        [itunes, largest ? getHighResVariant(largest, 1080) : null, largest],
        artistLine ? `${artistLine} - ${track.title}` : track.title,
      );
      toast.success("Cover saved", { description: path });
    } catch (e) {
      toast.error(`Couldn't save cover: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <TrackMenuItems
            item={item}
            controller={controller}
            primitives={ctxPrimitives}
            onGoToArtist={onGoToArtist}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={saving}
            onSelect={(e) => {
              // Keep the menu open while the fetch runs so the spinner
              // is visible instead of the menu vanishing on click.
              e.preventDefault();
              void saveCover();
            }}
          >
            {saving ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <DownloadIcon />
            )}
            Download cover
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NewPlaylistDialog
        open={controller.newPlaylistOpen}
        onOpenChange={controller.setNewPlaylistOpen}
        defaultTitle={item.title}
        videoId={item.id}
      />
    </>
  );
}
