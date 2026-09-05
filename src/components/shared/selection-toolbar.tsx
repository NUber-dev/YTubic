import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import {
  IconLoader2,
  IconPlaylist,
  IconPlayerTrackNextFilled,
  IconPlus,
} from "@tabler/icons-react";
import { IconPlaylistAddFilled } from "@/components/shared/filled-icons";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NewPlaylistDialog } from "@/components/shared/track-context-menu";
import {
  addManyToPlaylist,
  fetchUserPlaylists,
  type UserPlaylist,
} from "@/lib/innertube/mutations";
import { useLayoutStore } from "@/lib/store/layout";
import { usePlaybackStore } from "@/lib/store/playback";
import type { ShelfItem } from "@/lib/innertube/types";

type Props = {
  /** The selected rows, in list order. Nothing renders while empty. */
  tracks: ShelfItem[];
  onClear: () => void;
};

/**
 * The bar that floats up over the bottom of the content area while
 * rows of a track list are selected. Same anchoring as the
 * jump-to-current pill (and the same body-level portal, for the same
 * backdrop-filter reason): centred in the visible content, lifted over
 * the bottom player bar when there is one.
 */
export function SelectionToolbar({ tracks, onClear }: Props) {
  const { state } = useSidebar();
  const mode = useLayoutStore((s) => s.mode);
  const qc = useQueryClient();
  const [newPlaylistOpen, setNewPlaylistOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const count = tracks.length;

  // Labels give way to bare icons when the bar would not fit between
  // the sidebar and the player. The full width is measured only while
  // the labels are showing and kept, so the check does not chase its
  // own shrinking.
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const fullWidthRef = useRef(0);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const pill = pillRef.current;
    if (!wrap || !pill) return;
    const check = () => {
      if (!compact) fullWidthRef.current = pill.offsetWidth;
      setCompact(wrap.clientWidth < fullWidthRef.current + 16);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [count, compact]);

  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, onClear]);

  // Fetched only once the Save menu opens; the same key the track
  // menus use, so either warms the other.
  const playlists = useQuery({
    queryKey: ["user-playlists"],
    queryFn: () => fetchUserPlaylists(),
    staleTime: 60_000,
    retry: false,
    enabled: saveOpen,
  });

  if (count === 0) return null;

  const label = `${count} track${count === 1 ? "" : "s"}`;

  const saveTo = async (p: UserPlaylist) => {
    if (busy) return;
    setBusy(true);
    try {
      await addManyToPlaylist(
        p.id,
        tracks.map((t) => t.id),
      );
      await qc.invalidateQueries({ queryKey: ["playlist-pages"] });
      toast.success(`Added ${label} to ${p.title}`);
      onClear();
    } catch (e) {
      toast.error(`Add failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const playNext = () => {
    const store = usePlaybackStore.getState();
    // enqueueNext always inserts right after the current track, so the
    // selection goes in backwards to come out in list order.
    for (const t of [...tracks].reverse()) store.enqueueNext(t);
    toast.success(`Playing next: ${label}`);
    onClear();
  };

  const addToQueue = () => {
    usePlaybackStore.getState().appendToQueue(tracks);
    toast.success(`Added to queue: ${label}`);
    onClear();
  };

  const left = state === "collapsed" ? "3.5rem" : "13rem";
  const right = mode === "right" ? "23rem" : "1rem";
  const bottom = mode === "bottom" ? "6rem" : "1rem";

  // In compact mode every action is a round icon with its label in a
  // tooltip; otherwise a labelled ghost button.
  // `wrap` slots a Radix trigger between the tooltip and the button.
  const action = (
    label: string,
    icon: React.ReactNode,
    props: React.ComponentProps<typeof Button>,
    wrap: (button: React.ReactElement) => React.ReactElement = (b) => b,
  ) =>
    compact ? (
      <Tooltip>
        <TooltipTrigger asChild>
          {wrap(
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className="rounded-full"
              {...props}
            >
              {icon}
            </Button>,
          )}
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    ) : (
      wrap(
        <Button variant="ghost" size="sm" {...props}>
          {icon}
          {label}
        </Button>,
      )
    );

  return createPortal(
    <>
      <div
        ref={wrapRef}
        className="pointer-events-none fixed z-20 flex justify-center transition-[left,right,bottom] duration-150 ease-linear"
        style={{ left, right, bottom }}
      >
        <div
          ref={pillRef}
          role="toolbar"
          aria-label="Selected tracks"
          data-selection-ui
          className="pointer-events-auto flex w-fit max-w-full items-center gap-1 rounded-full border border-sidebar-border p-1.5 text-sidebar-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
          style={{
            backgroundColor: "var(--surface)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            aria-label="Clear selection"
            className="rounded-full"
          >
            <XIcon />
          </Button>
          <span
            className={cn(
              "ml-1 text-sm font-medium tabular-nums",
              compact ? "mr-3" : "mr-6",
            )}
          >
            {count} selected
          </span>
          <DropdownMenu open={saveOpen} onOpenChange={setSaveOpen}>
            {action(
              "Save to playlist",
              busy ? (
                <IconLoader2 className="animate-spin" />
              ) : (
                <IconPlaylist />
              ),
              { disabled: busy },
              (b) => (
                <DropdownMenuTrigger asChild>{b}</DropdownMenuTrigger>
              ),
            )}
            <DropdownMenuContent
              align="center"
              side="top"
              className="max-h-80 w-64 overflow-y-auto"
            >
              {playlists.isFetching && !playlists.data ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <IconLoader2 className="size-3 animate-spin" />
                  Loading…
                </div>
              ) : playlists.isError ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  Sign in to add to playlists.
                </div>
              ) : (playlists.data ?? []).length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No playlists yet.
                </div>
              ) : (
                (playlists.data ?? []).map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => void saveTo(p)}>
                    <span className="truncate">{p.title}</span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setNewPlaylistOpen(true)}>
                <IconPlus />
                New playlist…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {action("Play next", <IconPlayerTrackNextFilled />, {
            onClick: playNext,
          })}
          {action("Add to queue", <IconPlaylistAddFilled />, {
            onClick: addToQueue,
          })}
        </div>
      </div>
      <NewPlaylistDialog
        open={newPlaylistOpen}
        onOpenChange={setNewPlaylistOpen}
        defaultTitle={tracks[0]?.title ?? "New playlist"}
        videoIds={tracks.map((t) => t.id)}
      />
    </>,
    document.body,
  );
}
