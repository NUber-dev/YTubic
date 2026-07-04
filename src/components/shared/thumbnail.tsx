import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { cacheCoverToDisk } from "@/lib/cover-art";
import type { Thumbnail as YtThumbnail } from "@/lib/innertube/types";

/**
 * Try to coax a higher-resolution variant out of a thumbnail URL.
 *
 *  - `lh3.googleusercontent.com` / `yt3.ggpht.com` covers come with
 *    size params:
 *      • `=w120-h120-l90-rj`              — width/height pair
 *      • `=s120-c-k-c0x00ffffff-no-rj`    — single dimension square
 *      • `=w120-h120-c-k-l90-rj`          — w/h with crop modifiers
 *    We swap the leading size token for a bigger one and KEEP the
 *    trailing modifiers (`-l90`, `-rj`, `-c`, etc.) intact.
 *  - `i.ytimg.com/vi/{id}/{preset}.jpg` → `maxresdefault.jpg`. Not
 *    every video has it, so callers must wire `onError` fallback.
 *  - lh3 URL with NO size token at all → append one (some thumbnails
 *    arrive without any size hint).
 *
 * Returns `null` when no upgrade applies.
 */
export function getHighResVariant(url: string, size = 1080): string | null {
  if (/=w\d+-h\d+/.test(url)) {
    return url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
  }
  if (/=s\d+/.test(url)) {
    return url.replace(/=s\d+/, `=s${size}`);
  }
  const ytMatch = url.match(/(\/vi\/[^/]+\/)[^./]+\.jpg/);
  if (ytMatch) {
    return url.replace(ytMatch[0], `${ytMatch[1]}maxresdefault.jpg`);
  }
  if (
    /(?:lh3\.googleusercontent\.com|yt3\.ggpht\.com)/.test(url) &&
    !url.includes("=")
  ) {
    return `${url}=w${size}-h${size}-l90-rj`;
  }
  return null;
}

export function pickThumbnail(
  thumbnails: YtThumbnail[],
  targetSize = 256,
): string | null {
  if (!thumbnails.length) return null;
  // Prefer the smallest thumbnail that is still ≥ targetSize; fall back to largest.
  const sorted = [...thumbnails].sort(
    (a, b) => (a.width ?? 0) - (b.width ?? 0),
  );
  const match = sorted.find((t) => (t.width ?? 0) >= targetSize);
  return (match ?? sorted[sorted.length - 1]).url;
}

/**
 * Pick the largest thumbnail variant the API shipped — used as the
 * safe fallback when a `high-res` upgrade attempt fails to load.
 */
export function pickHighResThumbnail(
  thumbnails: YtThumbnail[],
): string | null {
  if (!thumbnails.length) return null;
  const sorted = [...thumbnails].sort(
    (a, b) => (a.width ?? 0) - (b.width ?? 0),
  );
  return sorted[sorted.length - 1].url;
}

type Props = {
  thumbnails: YtThumbnail[];
  alt: string;
  round?: boolean;
  className?: string;
  targetSize?: number;
  /** Opt in to fetching a higher-res render (player big cover, blurred
   *  background). When the rewritten URL fails to load we transparently
   *  fall back to the largest API-shipped variant. */
  highRes?: boolean;
  /** External hi-res override (e.g. iTunes 3000×3000 studio art looked
   *  up by the player bar). When set, this URL is preferred over the
   *  YT-derived upgrade. Falls through to the YT chain on load error. */
  overrideHighRes?: string | null;
};

export function Thumbnail({
  thumbnails,
  alt,
  round = false,
  className,
  targetSize = 256,
  highRes = false,
  overrideHighRes,
}: Props) {
  // Pick the small variant for the instant-paint layer regardless of
  // highRes — even when the upgraded image is the goal, we want SOMETHING
  // on screen by the next frame instead of a grey square.
  const lowRes = pickThumbnail(thumbnails, targetSize);
  const fallback = highRes ? pickHighResThumbnail(thumbnails) : lowRes;
  // Aim for ~2x targetSize so retina displays stay sharp, but never below
  // 720 — the upgrade is wasted otherwise. Keeps trafic proportional to the
  // actual rendered size instead of always asking for 1080.
  const upgraded =
    highRes && fallback
      ? getHighResVariant(fallback, Math.max(targetSize * 2, 720))
      : null;

  // Reset transient state whenever the source set changes so a track
  // switch doesn't leave us pinned to the previous track's flags.
  const [errored, setErrored] = useState(false);
  const [overrideErrored, setOverrideErrored] = useState(false);
  const [hiResLoaded, setHiResLoaded] = useState(false);
  // Resolved hi-res URL: either the localhost /cover URL (after the
  // Rust side has the bytes pinned to disk) or the original `upgraded`
  // URL if the resolve failed. Stays null until the resolve completes
  // — until then the blur-up base layer is what the user sees.
  const [resolvedUpgraded, setResolvedUpgraded] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setErrored(false);
    setOverrideErrored(false);
    setHiResLoaded(false);
  }, [lowRes, fallback, upgraded, overrideHighRes]);

  // Resolve `upgraded` through the disk cache. After the first session
  // hit for a given URL the in-memory memo returns synchronously, so
  // a re-render of the same thumbnail (track switch back, navigation)
  // stays free.
  useEffect(() => {
    setResolvedUpgraded(null);
    if (!upgraded) return;
    let cancelled = false;
    cacheCoverToDisk(upgraded).then((url) => {
      if (!cancelled) setResolvedUpgraded(url);
    });
    return () => {
      cancelled = true;
    };
  }, [upgraded]);

  // Priority: override (iTunes) → resolvedUpgraded (cached YT high-res
  // or original on cache miss) → fallback (YT largest API variant).
  // On error at any tier we drop to the next. The blur-up low-res
  // layer (the API's smallest variant) is always shown beneath while
  // a hi-res target loads.
  const target =
    overrideHighRes && !overrideErrored
      ? overrideHighRes
      : resolvedUpgraded && !errored
        ? resolvedUpgraded
        : fallback;
  const showLayered = !!(target && lowRes && target !== lowRes);

  const sharedImgProps = {
    loading: "lazy",
    decoding: "async",
    // Without `no-referrer` the webview sends `Referer:
    // http://localhost:1420/` to the Google image CDNs, which
    // sometimes triggers their bot/abuse heuristic and the
    // response comes back as an HTML error page — Chromium then
    // CORB-blocks it as a cross-origin protected MIME type.
    // Stripping the referrer makes the request look anonymous and
    // the CDN serves the actual bytes.
    referrerPolicy: "no-referrer",
  } as const;

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-muted",
        round ? "rounded-full" : "rounded-md",
        className,
      )}
    >
      {showLayered ? (
        <>
          {/* Static low-res placeholder — no blur, no scale, no
              transition. Sits underneath the hi-res image and stays
              put while the hi-res cross-fades in on top. */}
          <img
            {...sharedImgProps}
            src={lowRes!}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 size-full object-cover"
          />
          <img
            {...sharedImgProps}
            src={target!}
            alt={alt}
            onLoad={() => setHiResLoaded(true)}
            onError={() => {
              if (target === overrideHighRes) setOverrideErrored(true);
              else if (target === resolvedUpgraded) setErrored(true);
            }}
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-200",
              hiResLoaded ? "opacity-100" : "opacity-0",
            )}
          />
        </>
      ) : target ? (
        <img
          {...sharedImgProps}
          src={target}
          alt={alt}
          onError={() => {
            if (target === overrideHighRes) setOverrideErrored(true);
            else if (target === resolvedUpgraded) setErrored(true);
          }}
          className="size-full object-cover"
        />
      ) : null}
    </div>
  );
}
