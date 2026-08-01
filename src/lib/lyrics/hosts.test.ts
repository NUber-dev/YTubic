import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the failure mode that shipped in v0.4.1: `lrclib.ts` used the
 * webview's plain `fetch()`, and `lrclib.net` was in neither the CSP's
 * `connect-src` nor the Tauri HTTP capability allowlist. Both doors were
 * shut, so LRCLIB, the only duration-aware provider, returned nothing in
 * every packaged build.
 *
 * It went unnoticed for the same reason it is worth a test: Tauri injects
 * `app.security.csp` only when serving `build.frontendDist`, never against
 * `build.devUrl`. The provider therefore works perfectly in `tauri dev` and
 * fails only once installed, which is the one configuration nobody
 * exercises while writing lyrics code.
 *
 * Two invariants, checked against the real config files:
 *   1. Every provider reaches the network through `tauriFetch`, so the
 *      webview CSP never applies.
 *   2. Every host they build request URLs from is in the capability
 *      allowlist, which `tauri-plugin-http` enforces at the Rust boundary
 *      before any socket is opened.
 */

const LYRICS_DIR = join(process.cwd(), "src/lib/lyrics");
const CAPABILITIES = join(process.cwd(), "src-tauri/capabilities/default.json");

/** Source with comments removed, so hosts named only in prose don't count. */
function sourceWithoutComments(file: string): string {
  return readFileSync(join(LYRICS_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function providerFiles(): string[] {
  return readdirSync(LYRICS_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
}

function allowedHosts(): Set<string> {
  const cap = JSON.parse(readFileSync(CAPABILITIES, "utf8")) as {
    permissions: Array<
      string | { identifier: string; allow?: { url: string }[] }
    >;
  };
  const http = cap.permissions.find(
    (p): p is { identifier: string; allow?: { url: string }[] } =>
      typeof p === "object" && p.identifier === "http:default",
  );
  const hosts = new Set<string>();
  for (const entry of http?.allow ?? []) {
    hosts.add(new URL(entry.url.replace(/\*$/, "")).host);
  }
  return hosts;
}

/**
 * Hosts a file actually builds requests against, as opposed to hosts merely
 * named in a string (`Lrclib-Client` carries a github.com URL that is never
 * fetched). Only three shapes count: a `new URL(...)`, a direct
 * `tauriFetch(...)`, and a `const …URL/BASE/ENDPOINT` declaration.
 */
function requestedHosts(src: string): Set<string> {
  const patterns = [
    /new URL\(\s*[`"']https:\/\/([a-z0-9.-]+)/gi,
    /tauriFetch\(\s*[`"']https:\/\/([a-z0-9.-]+)/gi,
    /const\s+\w*(?:URL|BASE|ENDPOINT|API)\w*\s*=\s*[`"']https:\/\/([a-z0-9.-]+)/gi,
  ];
  const hosts = new Set<string>();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) hosts.add(m[1]);
  }
  return hosts;
}

describe("lyrics provider network access", () => {
  it("routes every provider through tauriFetch, never the webview's fetch", () => {
    for (const file of providerFiles()) {
      const src = sourceWithoutComments(file);
      // `fetch(` not preceded by an identifier character, so `tauriFetch(`
      // and `window.fetch(` are distinguishable from a bare global `fetch(`.
      const bare = src.match(/(?<![\w.])fetch\s*\(/g) ?? [];
      expect(
        bare,
        `${file} calls the webview's fetch(); the packaged build's CSP will block it`,
      ).toEqual([]);
    }
  });

  it("declares every host it requests in the Tauri HTTP capability", () => {
    const allowed = allowedHosts();
    for (const file of providerFiles()) {
      for (const host of requestedHosts(sourceWithoutComments(file))) {
        expect(
          allowed,
          `${file} requests ${host}, which is absent from capabilities/default.json, so tauri-plugin-http will reject it at the Rust boundary`,
        ).toContain(host);
      }
    }
  });

  // `requestedHosts` recognises three call shapes. A provider written in a
  // fourth would yield an empty set and sail through the check above, so
  // pin the expected host per file: adding a provider fails here until its
  // host is listed, which is the prompt to add the capability entry too.
  it("resolves the expected host for every provider that makes requests", () => {
    const expected: Record<string, string> = {
      "lrclib.ts": "lrclib.net",
      "musixmatch.ts": "apic-desktop.musixmatch.com",
      "genius.ts": "genius.com",
      "ytmusic.ts": "music.youtube.com",
    };
    const withRequests = providerFiles().filter(
      (f) => requestedHosts(sourceWithoutComments(f)).size > 0,
    );
    expect(withRequests.sort()).toEqual(Object.keys(expected).sort());
    for (const [file, host] of Object.entries(expected)) {
      expect([...requestedHosts(sourceWithoutComments(file))]).toContain(host);
    }
  });
});
