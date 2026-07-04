#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Isolated test harness for the /player resolver.
 *
 * For a given videoId, tries each youtubei.js client profile. For every
 * client that returns a URL, makes HTTP Range requests with a cartesian
 * set of (User-Agent × with/without Origin/Referer) combos and reports
 * which succeed. Goal: find a (client, request-header-set) that returns
 * 206 Partial Content with audio bytes.
 *
 * Run:  node scripts/test-player.mjs <videoId>
 */

import { Innertube, UniversalCache } from "youtubei.js";

const VIDEO_ID = process.argv[2] || "dQw4w9WgXcQ";

const CLIENTS = [
  "WEB_EMBEDDED",
  "TV_EMBEDDED",
  "MWEB",
  "IOS",
  "ANDROID",
  "WEB",
  "YTMUSIC",
];

const UA = {
  DESKTOP:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  IOS: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)",
  ANDROID: "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip",
  TV: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
};

const HEADER_SETS = [
  { name: "DESKTOP + Origin", ua: UA.DESKTOP, origin: true },
  { name: "DESKTOP no-origin", ua: UA.DESKTOP, origin: false },
  { name: "IOS no-origin", ua: UA.IOS, origin: false },
  { name: "IOS + Origin", ua: UA.IOS, origin: true },
  { name: "ANDROID no-origin", ua: UA.ANDROID, origin: false },
  { name: "TV + Origin", ua: UA.TV, origin: true },
  { name: "no-UA", ua: undefined, origin: false },
];

async function makeClient() {
  return await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: false,
  });
}

async function resolveWith(yt, client) {
  try {
    const info = await yt.getBasicInfo(VIDEO_ID, { client });
    const status = info?.playability_status?.status;
    if (status && status !== "OK") {
      return { error: `${status}: ${info?.playability_status?.reason ?? ""}` };
    }
    const chosen = info.chooseFormat({
      type: "audio",
      quality: "best",
      format: "any",
    });
    if (!chosen) return { error: "no format" };

    // Normalize URL.
    let url = chosen.url;
    if (url && typeof url.then === "function") url = await url;
    if (!url || typeof url !== "string") {
      if (typeof chosen.decipher === "function") {
        try {
          const player = await yt.session.player;
          const result = chosen.decipher(player);
          url = typeof result?.then === "function" ? await result : result;
        } catch (e) {
          return { error: `decipher: ${e.message}` };
        }
      }
    }
    if (!url || typeof url !== "string") {
      return { error: `bad url (${typeof url})` };
    }
    return {
      url,
      itag: chosen.itag,
      mime: chosen.mime_type,
      bitrate: chosen.bitrate,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function probe(url, headerSet) {
  const headers = {
    Accept: "*/*",
    Range: "bytes=0-1023",
  };
  if (headerSet.ua) headers["User-Agent"] = headerSet.ua;
  if (headerSet.origin) {
    headers.Origin = "https://www.youtube.com";
    headers.Referer = "https://www.youtube.com/";
  }
  try {
    const res = await fetch(url, { method: "GET", headers });
    const bodyLen = (await res.arrayBuffer()).byteLength;
    return { status: res.status, bodyLen };
  } catch (e) {
    return { status: "ERR", bodyLen: 0, err: e.message };
  }
}

async function main() {
  console.log(`Testing videoId: ${VIDEO_ID}`);
  console.log("Initializing youtubei.js (fetches real visitor_data)…\n");
  const yt = await makeClient();

  for (const client of CLIENTS) {
    process.stdout.write(`\n=== ${client} ===\n`);
    const r = await resolveWith(yt, client);
    if ("error" in r) {
      console.log(`  resolve failed: ${r.error}`);
      continue;
    }
    console.log(
      `  itag=${r.itag}  mime=${r.mime}  bitrate=${r.bitrate}`,
    );
    // Print the c= param from the URL.
    const cParam = new URL(r.url).searchParams.get("c");
    console.log(`  url c=${cParam}  length=${r.url.length}`);

    for (const hs of HEADER_SETS) {
      const p = await probe(r.url, hs);
      const tag =
        p.status === 200 || p.status === 206
          ? "✓"
          : p.status === 403
            ? "✗"
            : "?";
      console.log(
        `    ${tag} ${hs.name.padEnd(20)} → ${p.status}  ${p.bodyLen}b ${p.err ?? ""}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
