import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  authHeaders,
  captureSetCookies,
  readRuns,
  DESKTOP_UA,
  type YtNode,
} from "./shared";

/**
 * One selectable YouTube identity inside the signed-in Google account:
 * the personal (default) channel or a brand channel. Library, likes,
 * uploads and recommendations are scoped to the channel, so the app
 * lets the user pick which one to act as.
 */
export type ChannelChoice = {
  /** Value for the `X-Goog-PageId` header; null = personal channel. */
  pageId: string | null;
  name: string;
  photoUrl?: string;
  /** Secondary line YT ships for the row (email, "Brand Account", …). */
  byline?: string;
  /** What the switcher itself reports as selected (server-side view). */
  selected: boolean;
};

const SWITCHER_URL = "https://music.youtube.com/getAccountSwitcherEndpoint";

/**
 * YouTube prefixes switcher JSON with the XSSI guard `)]}'`. Strip it
 * (and anything else before the first `{` or `[`) so JSON.parse works.
 */
export function stripXssiPrefix(text: string): string {
  const start = text.search(/[[{]/);
  return start > 0 ? text.slice(start) : text;
}

/**
 * List every channel the signed-in Google account can act as. Uses the
 * same endpoint the official web client's account switcher calls.
 * Returns [] when signed out.
 */
export async function fetchChannelList(): Promise<ChannelChoice[]> {
  const auth = await authHeaders();
  if (!auth.Cookie) return [];
  const res = await tauriFetch(SWITCHER_URL, {
    method: "GET",
    headers: {
      ...auth,
      "User-Agent": DESKTOP_UA,
      Referer: "https://music.youtube.com/",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  // This page-level endpoint is the one that mints the post-login
  // LOGIN_INFO / SIDCC burst; echoing it into the jar is what keeps
  // the fresh session alive (see captureSetCookies).
  await captureSetCookies(res);
  if (!res.ok) {
    throw new Error(`account switcher: HTTP ${res.status}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(stripXssiPrefix(text));
  } catch {
    throw new Error("account switcher: response is not JSON");
  }
  return parseAccountSwitcher(json);
}

/**
 * Walk the switcher response and collect every `accountItem` node.
 * The exact nesting varies (multiPageMenuRenderer sections wrapped in
 * varying action envelopes), so we scan the whole tree instead of
 * hard-coding a path; identity rows are the only nodes with an
 * `accountItem` key.
 */
export function parseAccountSwitcher(root: unknown): ChannelChoice[] {
  const out: ChannelChoice[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const n = node as YtNode;
    if (n.accountItem && typeof n.accountItem === "object") {
      const mapped = mapAccountItem(n.accountItem as YtNode);
      if (mapped) out.push(mapped);
      return;
    }
    for (const key of Object.keys(n)) walk(n[key]);
  };
  walk(root);
  return out;
}

function mapAccountItem(item: YtNode): ChannelChoice | null {
  // Rows without a select endpoint ("Add account", "View channel",
  // sign-out shortcuts) are not identities; skip them.
  const endpoint = item.serviceEndpoint?.selectActiveIdentityEndpoint;
  if (!endpoint) return null;

  const name = readRuns(item.accountName);
  if (!name) return null;

  // Brand channels carry a pageIdToken among the endpoint's tokens;
  // the personal channel has none.
  let pageId: string | null = null;
  const tokens: YtNode[] = endpoint.supportedTokens ?? [];
  for (const t of tokens) {
    const pid = t?.pageIdToken?.pageId;
    if (typeof pid === "string" && pid) {
      pageId = pid;
      break;
    }
  }

  const photos: YtNode[] = item.accountPhoto?.thumbnails ?? [];
  const photoUrl = photos[photos.length - 1]?.url as string | undefined;

  return {
    pageId,
    name,
    photoUrl,
    byline: readRuns(item.accountByline) || undefined,
    selected: item.isSelected === true,
  };
}
