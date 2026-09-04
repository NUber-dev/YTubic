import { create } from "zustand";
import type { ReactNode } from "react";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

/**
 * Snapshot of whatever the current route's `<EntityHeader>` published.
 * Consumed by `<EntityPageHeader>`, which overlays the top of the
 * content column. `headerHeight` reserves the expanded header space;
 * it stays constant while the visual header follows the scroll.
 */
export type EntityHeaderConfig = {
  title: string;
  subtitle?: ReactNode;
  metadata?: string;
  thumbnails: YtThumbnail[];
  /** Rendered in place of the thumbnail, for artwork the app draws
   *  itself (Liked songs). */
  cover?: ReactNode;
  round: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  actions?: ReactNode;
  toolbar?: ReactNode;
  keepSubtitleInCompact?: boolean;
};

type State = {
  config: EntityHeaderConfig | null;
  headerHeight: number;
  setConfig: (config: EntityHeaderConfig | null) => void;
  setHeaderHeight: (height: number) => void;
};

export const useEntityHeaderStore = create<State>((set) => ({
  config: null,
  headerHeight: 0,
  setConfig: (config) => set({ config }),
  setHeaderHeight: (headerHeight) => set({ headerHeight }),
}));
