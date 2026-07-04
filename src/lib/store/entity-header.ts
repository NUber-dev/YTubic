import { create } from "zustand";
import type { ReactNode } from "react";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

/**
 * Snapshot of whatever the current route's `<EntityHeader>` published.
 * Consumed by `<EntityPageHeader>`, which sits at the top of the
 * content column (above `<main>`) and renders both the full hero and
 * the compact bar from the same data — switching between them on
 * scroll.
 *
 * Living outside `<main>` is what guarantees the bar naturally hides
 * the track list scrolling underneath: `<main>` clips its own
 * overflow, so its rows can never reach above the column's `<main>`
 * top edge. The bar inherits the app-wide blurred-cover tint from
 * `<BackgroundCover>` without needing any background of its own.
 */
export type EntityHeaderConfig = {
  title: string;
  subtitle?: string;
  metadata?: string;
  description?: string;
  thumbnails: YtThumbnail[];
  round: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
  actions?: ReactNode;
};

type State = {
  config: EntityHeaderConfig | null;
  setConfig: (config: EntityHeaderConfig | null) => void;
};

export const useEntityHeaderStore = create<State>((set) => ({
  config: null,
  setConfig: (config) => set({ config }),
}));
