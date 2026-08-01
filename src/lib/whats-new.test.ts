import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WHATS_NEW } from "./whats-new";

/**
 * Release-time guards for the changelog the app shows itself.
 *
 * The version lives in four files and the notes in a fifth, and the two
 * are only connected by remembering. A release that bumps one without the
 * other either shows the previous release's notes to everyone who updates,
 * or shows nothing at all.
 */

function appVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

describe("What's New", () => {
  it("leads with an entry for the version being shipped", () => {
    expect(
      WHATS_NEW[0]?.version,
      "package.json was bumped without adding the matching What's New entry, so the dialog will show the previous release's notes",
    ).toBe(appVersion());
  });

  it("keeps every version file in step with package.json", () => {
    const root = process.cwd();
    const version = appVersion();
    const tauri = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string };
    expect(tauri.version, "src-tauri/tauri.conf.json").toBe(version);

    const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
    expect(
      cargo.match(/^version = "(.+?)"/m)?.[1],
      "src-tauri/Cargo.toml",
    ).toBe(version);

    const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
    expect(
      lock.match(/name = "ytubic"\nversion = "(.+?)"/)?.[1],
      "src-tauri/Cargo.lock, which needs `cargo update -w` after a bump",
    ).toBe(version);
  });

  it("is ordered newest first, since the dialog renders it as a timeline", () => {
    const rank = (v: string) =>
      v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
    for (let i = 1; i < WHATS_NEW.length; i++) {
      expect(
        rank(WHATS_NEW[i - 1].version),
        `${WHATS_NEW[i - 1].version} should sort above ${WHATS_NEW[i].version}`,
      ).toBeGreaterThan(rank(WHATS_NEW[i].version));
    }
  });

  it("has no duplicate versions", () => {
    const seen = WHATS_NEW.map((e) => e.version);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("carries no em or en dashes, which read as machine-written", () => {
    for (const entry of WHATS_NEW) {
      const prose = [
        entry.summary,
        entry.note ?? "",
        entry.alert ?? "",
        ...entry.changes.flatMap((c) => [c.title, c.text]),
      ].join(" ");
      expect(prose, `${entry.version} contains a dash character`).not.toMatch(
        /[–—]/,
      );
    }
  });

  it("gives every change a type, a title and some detail", () => {
    for (const entry of WHATS_NEW) {
      expect(entry.changes.length, `${entry.version} has no changes`).toBeGreaterThan(0);
      for (const c of entry.changes) {
        expect(["new", "improved", "fixed", "security"]).toContain(c.type);
        expect(c.title.trim().length, `${entry.version}: empty title`).toBeGreaterThan(0);
        expect(c.text.trim().length, `${entry.version}: "${c.title}" has no detail`).toBeGreaterThan(20);
        expect(c.title.trim().endsWith("."), `${entry.version}: "${c.title}" ends with a period`).toBe(false);
      }
    }
  });
});
