import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_CHOICE_ITEM, MENU_ITEM } from "@/components/ui/menu-chrome";

/**
 * Every row of a menu has to line up with the rows above and below it.
 *
 * `track-context-menu.tsx` renders one menu from two interchangeable
 * primitive families: right-click gets the ContextMenu set, the "..."
 * button gets the DropdownMenu set. Upstream ships them as two separate
 * files with two separate copies of the row styling, which is how
 * `context-menu-sub-trigger` once ended up without the icon-to-label gap
 * that every other row carried: "Add to playlist" had its icon jammed
 * against its label on right-click and looked correct from the button.
 *
 * Both families now take their rows from `menu-chrome.ts`, so the way to
 * keep them aligned is to keep them on the shared constants rather than
 * to compare two hand-written class lists. Worth a test rather than just
 * a fix: these files are generated, and re-running the shadcn CLI to add
 * or update a component rewrites them wholesale, putting the local class
 * strings back. A one-row spacing difference inside a submenu is exactly
 * what nobody re-checks.
 */

const UI = join(process.cwd(), "src/components/ui");

/** Icon-to-label spacing and padding, shared by every row. */
const LAYOUT = ["flex", "items-center", "gap-[11px]", "px-2.5", "py-1.5"];

/**
 * Which shared constant each row is expected to be built from. Checkbox
 * and radio rows get their own because they also have to hold a trailing
 * tick without wrapping, but they carry the same layout tokens.
 */
const ROWS: [string, string, string][] = [
  ["context-menu.tsx", "context-menu-item", "MENU_ITEM"],
  ["context-menu.tsx", "context-menu-checkbox-item", "MENU_CHOICE_ITEM"],
  ["context-menu.tsx", "context-menu-radio-item", "MENU_CHOICE_ITEM"],
  ["context-menu.tsx", "context-menu-sub-trigger", "MENU_ITEM"],
  ["dropdown-menu.tsx", "dropdown-menu-item", "MENU_ITEM"],
  ["dropdown-menu.tsx", "dropdown-menu-checkbox-item", "MENU_CHOICE_ITEM"],
  ["dropdown-menu.tsx", "dropdown-menu-radio-item", "MENU_CHOICE_ITEM"],
  ["dropdown-menu.tsx", "dropdown-menu-sub-trigger", "MENU_ITEM"],
];

/** The first thing the row's `cn()` is handed, which should be a constant. */
function baseOfSlot(file: string, slot: string): string {
  const src = readFileSync(join(UI, file), "utf8");
  const m = src.match(
    new RegExp(
      `data-slot="${slot}"[\\s\\S]{0,1200}?className=\\{cn\\(\\s*(?://[^\\n]*\\n\\s*)*([A-Za-z_$][\\w$]*|")`,
    ),
  );
  if (!m)
    throw new Error(`no className found for data-slot="${slot}" in ${file}`);
  return m[1];
}

describe("menu rows align with each other", () => {
  it.each(ROWS)("%s / %s is built from the shared row", (file, slot, base) => {
    expect(
      baseOfSlot(file, slot),
      `${slot} spells its own layout instead of taking ${base}, so it can drift from the rows around it`,
    ).toBe(base);
  });

  it.each([
    ["MENU_ITEM", MENU_ITEM],
    ["MENU_CHOICE_ITEM", MENU_CHOICE_ITEM],
  ])("%s carries the shared layout", (name, value) => {
    const cls = value.split(/\s+/).filter(Boolean);
    for (const token of LAYOUT) {
      expect(cls, `${name} is missing "${token}"`).toContain(token);
    }
  });

  it("keeps the two families interchangeable, since one menu uses both", () => {
    // Any divergence shows up as the same menu looking different depending
    // on whether it was opened by right-click or by the "..." button.
    for (const [ctx, dd] of [
      ["context-menu-item", "dropdown-menu-item"],
      ["context-menu-checkbox-item", "dropdown-menu-checkbox-item"],
      ["context-menu-radio-item", "dropdown-menu-radio-item"],
      ["context-menu-sub-trigger", "dropdown-menu-sub-trigger"],
    ]) {
      expect(
        baseOfSlot("context-menu.tsx", ctx),
        `${ctx} and ${dd} are built from different rows`,
      ).toBe(baseOfSlot("dropdown-menu.tsx", dd));
    }
  });
});
