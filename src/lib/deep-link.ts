import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

/**
 * `ytubic://` links. The scheme is registered by the installer (and at
 * runtime in dev / on Linux), so opening one launches or focuses the app:
 *
 *   ytubic://watch?v=<videoId>
 *   ytubic://artist/<channelId>
 *   ytubic://album/<browseId>
 *   ytubic://playlist/<playlistId>
 */
export type DeepLinkTarget =
  | { kind: "watch"; id: string }
  | { kind: "artist" | "album" | "playlist"; id: string };

const ID_RE = /^[A-Za-z0-9_-]{6,}$/;

export function ytubicShareUrl(kind: DeepLinkTarget["kind"], id: string): string {
  return kind === "watch" ? `ytubic://watch?v=${id}` : `ytubic://${kind}/${id}`;
}

/**
 * Universal share link: a GitHub Pages landing page (docs/s/) that offers
 * "Open in YTubic" (the ytubic:// link above) and falls back to YouTube
 * Music, so the link works for people without the app too. Songs get
 * their metadata from YouTube's oEmbed; other entities carry a title.
 */
export const SHARE_BASE = "https://nuber-dev.github.io/YTubic/s/";

export function universalShareUrl(
  kind: DeepLinkTarget["kind"],
  id: string,
  title?: string,
): string {
  const q = new URLSearchParams();
  q.set(kind === "watch" ? "v" : kind, id);
  if (kind !== "watch" && title) q.set("t", title);
  return `${SHARE_BASE}?${q.toString()}`;
}

export function parseDeepLink(raw: string): DeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "ytubic:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "watch") {
    const v = url.searchParams.get("v") ?? "";
    return ID_RE.test(v) ? { kind: "watch", id: v } : null;
  }
  if (host === "artist" || host === "album" || host === "playlist") {
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    return ID_RE.test(id) ? { kind: host, id } : null;
  }
  return null;
}

/**
 * Subscribe to deep links: the one the app was launched with (cold start)
 * and those forwarded by the single-instance plugin while running.
 */
export function listenDeepLinks(
  handle: (target: DeepLinkTarget) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const seen = new Set<string>();
  const dispatch = (urls: string[] | null | undefined) => {
    for (const raw of urls ?? []) {
      const target = parseDeepLink(raw);
      if (target) handle(target);
    }
  };
  void (async () => {
    try {
      const start = await getCurrent();
      if (!disposed && start) {
        start.forEach((u) => seen.add(u));
        dispatch(start);
      }
      const un = await onOpenUrl((urls) => {
        // Cold-start URLs can be replayed by the plugin on first listen.
        const fresh = urls.filter((u) => !seen.has(u));
        seen.clear();
        dispatch(fresh);
      });
      if (disposed) un();
      else unlisten = un;
    } catch (e) {
      console.error("[deep-link]", e);
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
