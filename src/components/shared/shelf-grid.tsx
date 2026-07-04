import { ShelfCard } from "@/components/shared/shelf-card";
import type { Shelf } from "@/lib/innertube/types";

type Props = {
  shelf: Shelf;
};

// Vertical grid layout — used for shelves of `musicNavigationButtonRenderer`
// tiles (Moods & Genres). Same `<ShelfCard>` renders the tile itself; the
// only difference from `<ShelfCarousel>` is that this lays them out in a
// responsive CSS grid instead of a horizontally-scrolling row.
export function ShelfGrid({ shelf }: Props) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="truncate text-xl font-semibold tracking-tight">
          {shelf.title}
        </h2>
        {shelf.subtitle ? (
          <span className="truncate text-sm text-muted-foreground">
            {shelf.subtitle}
          </span>
        ) : null}
      </div>

      {/* Adaptive grid: each tile is between 14rem and 20rem wide; the
          column count auto-fills to fit the viewport. `min(100%, 14rem)`
          prevents the min from ever exceeding the container itself, so
          on very narrow viewports we collapse to a single full-width
          column instead of overflowing horizontally. */}
      <div className="grid w-full gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] [&>*]:max-w-[20rem]">
        {shelf.items.map((item) => (
          <ShelfCard key={`${item.kind}:${item.id}`} item={item} />
        ))}
      </div>
    </section>
  );
}
