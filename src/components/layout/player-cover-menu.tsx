import { useState, type ReactNode } from "react";
import { IconDownload, IconLoader2 } from "@tabler/icons-react";
import { toast } from "sonner";
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
 */
export function PlayerCoverMenu({ track, children }: Props) {
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
              <IconLoader2 className="animate-spin" />
            ) : (
              <IconDownload />
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
