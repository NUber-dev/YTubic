import { useState } from "react";
import { EyeIcon, EyeOffIcon, GripVerticalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { frostedOverlay, frostedSurface } from "@/components/ui/frosted";
import { arrangeTitles, useHomeSectionsStore } from "@/lib/store/home-sections";
import { cn } from "@/lib/utils";

/**
 * The home feed's sections as a list the user can drag into order and
 * switch off one by one. Only sections the feed has actually returned
 * are listed; a saved title the feed no longer sends stays in the store
 * (it may come back) but has no row.
 */
export function HomeConfigureDialog({
  open,
  onOpenChange,
  titles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every section title the feed has loaded so far, in feed order. */
  titles: string[];
}) {
  const order = useHomeSectionsStore((s) => s.order);
  const hidden = useHomeSectionsStore((s) => s.hidden);
  const setOrder = useHomeSectionsStore((s) => s.setOrder);
  const setHidden = useHomeSectionsStore((s) => s.setHidden);
  const reset = useHomeSectionsStore((s) => s.reset);

  const present = new Set(titles);
  const rows = arrangeTitles(titles, order).filter((t) => present.has(t));

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    const next = [...rows];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={frostedOverlay}
        className={cn(
          "flex max-h-[85vh] w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-[20px] p-0 sm:max-w-[420px]",
          "shadow-[0_30px_70px_-20px_var(--k850)]",
          frostedSurface,
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 z-[1] h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <div className="flex flex-col gap-1 border-b border-w055 px-5 pb-4 pt-5">
          <DialogTitle className="text-xl font-semibold leading-none tracking-[-0.015em] text-t1">
            Home sections
          </DialogTitle>
          <DialogDescription className="text-[13px] text-t7">
            Drag to reorder. Hidden sections stay out of the feed.
          </DialogDescription>
        </div>

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-[13.5px] text-t5">
              Nothing loaded yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-px">
              {rows.map((title, i) => {
                const off = hidden.includes(title);
                return (
                  <li
                    key={title}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", title);
                      e.dataTransfer.effectAllowed = "move";
                      setDragFrom(i);
                    }}
                    onDragOver={(e) => {
                      if (dragFrom === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOver(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null && dragFrom !== i) {
                        // The indicator sits above the hovered row, so a
                        // downward move lands one short once the dragged
                        // row is spliced out.
                        move(dragFrom, dragFrom < i ? i - 1 : i);
                      }
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    className={cn(
                      "group relative flex cursor-grab select-none items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-[140ms] hover:bg-w050 active:cursor-grabbing",
                      dragFrom === i && "opacity-40",
                      dragOver === i &&
                        dragFrom !== i &&
                        "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-acc1",
                    )}
                  >
                    <GripVerticalIcon className="size-4 shrink-0 text-t8" />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[13.5px]",
                        off ? "text-t7 line-through" : "text-t1",
                      )}
                    >
                      {title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setHidden(title, !off)}
                      aria-label={off ? "Show section" : "Hide section"}
                      aria-pressed={off}
                      className={cn(
                        "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors duration-[140ms]",
                        off
                          ? "text-t6 hover:bg-w070 hover:text-t2"
                          : "text-t8 hover:bg-w070 hover:text-t2",
                      )}
                    >
                      {off ? (
                        <EyeOffIcon className="size-4" />
                      ) : (
                        <EyeIcon className="size-4" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-w055 px-5 py-3.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={order.length === 0 && hidden.length === 0}
          >
            Reset
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
