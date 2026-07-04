import { useEffect, type ReactNode } from "react";
import { useEntityHeaderStore } from "@/lib/store/entity-header";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

type Props = {
  title: string;
  subtitle?: string;
  metadata?: string;
  description?: string;
  thumbnails: YtThumbnail[];
  round?: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  /** Extra buttons rendered after Play/Shuffle — used for entity-
   *  specific actions (Pin playlist, Follow artist, etc.). */
  actions?: ReactNode;
};

/**
 * Data-only header marker. The actual hero / compact bar UI lives in
 * `<EntityPageHeader>` at the top of the content column (above
 * `<main>`); this component just publishes whatever the current route
 * wants the header to show. Rendering nothing keeps the route's flex
 * column free of an empty slot — the page content (sort menu, track
 * list, etc.) sits flush below the bar.
 */
export function EntityHeader({
  title,
  subtitle,
  metadata,
  description,
  thumbnails,
  round = false,
  onPlay,
  onShuffle,
  actions,
}: Props) {
  const setConfig = useEntityHeaderStore((s) => s.setConfig);

  // Re-publish every render so prop changes (new title after a slow
  // fetch, sort-mode flipping the actions, etc.) flow through. The
  // cleanup clears the store on unmount so a route without an
  // EntityHeader doesn't inherit the previous page's bar.
  useEffect(() => {
    setConfig({
      title,
      subtitle,
      metadata,
      description,
      thumbnails,
      round,
      onPlay,
      onShuffle,
      actions,
    });
    return () => setConfig(null);
  });

  return null;
}
