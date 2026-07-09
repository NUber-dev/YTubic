import { describe, expect, it } from "vitest";
import { splitSetCookieHeader } from "./shared";

// Fallback splitter for runtimes without Headers.getSetCookie. The
// tricky part is NOT splitting on the comma inside an Expires date.
describe("splitSetCookieHeader", () => {
  it("returns [] for an empty header", () => {
    expect(splitSetCookieHeader("")).toEqual([]);
  });

  it("keeps a single cookie with an Expires date intact", () => {
    const raw =
      "SIDCC=AKEy_abc123; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Path=/; Domain=.youtube.com; Secure";
    expect(splitSetCookieHeader(raw)).toEqual([raw]);
  });

  it("splits two cookies joined with a comma", () => {
    const a =
      "SIDCC=AKEy_abc; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Domain=.youtube.com; Path=/";
    const b =
      "LOGIN_INFO=AFmmF2s:QUQ3; Expires=Thu, 06 Jul 2028 18:24:08 GMT; Domain=.youtube.com; Path=/; Secure; HttpOnly";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });

  it("handles __Secure- prefixed names after the comma", () => {
    const a = "SIDCC=v1; Domain=.youtube.com; Path=/";
    const b = "__Secure-3PSIDCC=v2; Domain=.youtube.com; Path=/; Secure";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });
});
