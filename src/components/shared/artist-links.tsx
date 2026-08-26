import { Fragment } from "react";
import { EntityLink } from "@/components/shared/entity-link";
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
 * an id render as plain text (unclickable). `EntityLink` handles the
 * floating-player window, which has no router.
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
            <EntityLink
              to="/artist/$id"
              id={a.id}
              event="nav:artist"
              className={linkClassName}
            >
              {a.name}
            </EntityLink>
          ) : (
            a.name
          )}
        </Fragment>
      ))}
    </span>
  );
}
