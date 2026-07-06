import { innertubePost, readRuns, type YtNode } from "./shared";



export type BrandChannel = {

  /** 21-digit `onBehalfOfUser` id; `null` = primary Google channel */

  brandId: string | null;

  channelName: string;

  channelHandle?: string;

  isSelected?: boolean;

};



const PAGE_ID_RE = /^\d{21}$/;



/**

 * Brand page ids live only under `selectActiveIdentityEndpoint`. A blind

 * tree-walk was picking up unrelated 21-digit ids and sending a bogus

 * `onBehalfOfUser`, which makes library browse return HTTP 404.

 */

function extractBrandPageId(item: YtNode): string | null {

  const endpoint = (item.serviceEndpoint ?? item.endpoint) as YtNode | undefined;

  if (!endpoint) return null;



  const select =

    endpoint.selectActiveIdentityEndpoint ??

    (endpoint.command as YtNode | undefined)?.selectActiveIdentityEndpoint;

  if (!select) return null;



  const tokens = (select as YtNode).supportedTokens as YtNode[] | undefined;

  if (!Array.isArray(tokens)) return null;



  for (const token of tokens) {

    const pageId = token?.pageIdToken?.pageId;

    if (typeof pageId === "string" && PAGE_ID_RE.test(pageId)) {

      return pageId;

    }

  }

  return null;

}



function collectAccountItems(root: unknown): YtNode[] {

  const out: YtNode[] = [];

  const seen = new WeakSet<object>();

  const walk = (node: unknown) => {

    if (!node || typeof node !== "object") return;

    if (seen.has(node as object)) return;

    seen.add(node as object);



    if (Array.isArray(node)) {

      for (const child of node) walk(child);

      return;

    }



    const n = node as YtNode;

    if (n.accountName) {

      out.push(n);

      return;

    }

    for (const key of Object.keys(n)) walk(n[key]);

  };

  walk(root);

  return out;

}



/**

 * List primary + brand YouTube channels for the active cookie jar.

 * Uses InnerTube `account/accounts_list` with an empty body — the

 * CHANNEL_SWITCHER requestType only returns `selectText` on WEB_REMIX.

 */

export async function fetchChannelList(): Promise<BrandChannel[]> {

  const json = await innertubePost("account/accounts_list", {});



  const items = collectAccountItems(json);

  const channels: BrandChannel[] = [];



  for (const item of items) {

    const channelName = readRuns(item.accountName);

    if (!channelName) continue;

    const channelHandle = readRuns(item.channelHandle) || undefined;

    const brandId = extractBrandPageId(item);

    channels.push({

      brandId,

      channelName,

      channelHandle: channelHandle || undefined,

      isSelected: !!item.isSelected,

    });

  }



  // Deduplicate by brandId + name (API sometimes repeats sections).

  const seen = new Set<string>();

  return channels.filter((c) => {

    const key = `${c.brandId ?? "primary"}:${c.channelName}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;

  });

}


