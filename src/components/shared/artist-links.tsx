import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { isFloatingPlayerWindow } from "@/lib/floating-player";
import type { MinimalArtist } from "@/lib/innertube/types";

type Props = {
  artists: MinimalArtist[] | undefined;
  /** Plain text shown when the track has no artists at all. */
  fallback?: string;
  className?: string;
  /** Per-link className — applied to the `<a>` (or button in floating). */
  linkClassName?: string;
};

/**
 * Renders a comma-separated artist list with each artist that has an
 * `id` rendered as a navigable link to `/artist/$id`. Names without
 * an id render as plain text (unclickable). Used in every player
 * variant — the right card, the bottom bar, and the floating-window
 * card — so the cross-window navigation case is handled here once.
 *
 * In the floating-player window there's no router, so a click emits
 * `nav:artist` via Tauri events and asks Rust to bring the main
 * window to the front. The main window's `<AppShell>` listens for
 * that event and runs the actual navigation.
 */
export function ArtistLinks({
  artists,
  fallback,
  className,
  linkClassName,
}: Props) {
  if (!artists || artists.length === 0) {
    return fallback ? <span className={className}>{fallback}</span> : null;
  }
  return (
    <span className={className}>
      {artists.map((a, i) => (
        <Fragment key={`${a.id ?? a.name}-${i}`}>
          {i > 0 ? ", " : ""}
          {a.id ? (
            <ArtistLink id={a.id} name={a.name} className={linkClassName} />
          ) : (
            a.name
          )}
        </Fragment>
      ))}
    </span>
  );
}

function ArtistLink({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string;
}) {
  const cls = cn(
    "cursor-pointer transition-colors hover:text-foreground hover:underline",
    className,
  );

  if (isFloatingPlayerWindow()) {
    return (
      <button
        type="button"
        className={cls}
        onClick={() => {
          void emit("nav:artist", { id });
          // Best-effort: pull the main window to the front so the
          // user actually sees the page they just opened.
          void invoke("focus_main_window").catch(() => {
            /* command might not be registered in older builds */
          });
        }}
      >
        {name}
      </button>
    );
  }

  return (
    <Link to="/artist/$id" params={{ id }} className={cls}>
      {name}
    </Link>
  );
}
