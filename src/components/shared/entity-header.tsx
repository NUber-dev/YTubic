import { useEffect, type ReactNode } from "react";
import { useEntityHeaderStore } from "@/lib/store/entity-header";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

type Props = {
  title: string;
  subtitle?: ReactNode;
  metadata?: string;
  thumbnails: YtThumbnail[];
  /** Artwork the route draws itself, instead of a fetched thumbnail. */
  cover?: ReactNode;
  round?: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  /** Extra buttons rendered after Play/Shuffle — used for entity-
   *  specific actions (Pin playlist, Follow artist, etc.). */
  actions?: ReactNode;
  /** Full-width controls pinned below both expanded and compact states. */
  toolbar?: ReactNode;
  /** Keep the subtitle as a second line in the compact header. */
  keepSubtitleInCompact?: boolean;
};

/**
 * Data-only header marker. The actual morphing overlay UI lives in
 * `<EntityPageHeader>` at the top of the content column (above
 * `<main>`); this component just publishes whatever the current route
 * wants the header to show. Rendering nothing keeps the route's flex
 * column free of an empty slot — the page content (sort menu, track
 * list, etc.) sits flush below the reserved header space.
 */
export function EntityHeader({
  title,
  subtitle,
  metadata,
  thumbnails,
  cover,
  round = false,
  onPlay,
  onShuffle,
  actions,
  toolbar,
  keepSubtitleInCompact = false,
}: Props) {
  const setConfig = useEntityHeaderStore((s) => s.setConfig);

  // Publish prop changes without clearing the store between ordinary
  // route re-renders. Clearing is handled by a separate unmount effect.
  useEffect(() => {
    setConfig({
      title,
      subtitle,
      metadata,
      thumbnails,
      cover,
      round,
      onPlay,
      onShuffle,
      actions,
      toolbar,
      keepSubtitleInCompact,
    });
  }, [
    actions,
    cover,
    metadata,
    keepSubtitleInCompact,
    onPlay,
    onShuffle,
    round,
    setConfig,
    subtitle,
    thumbnails,
    title,
    toolbar,
  ]);

  useEffect(() => () => setConfig(null), [setConfig]);

  return null;
}
