import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every row of a menu has to line up with the rows above and below it.
 *
 * `track-context-menu.tsx` renders one menu from two interchangeable
 * primitive families: right-click gets the ContextMenu set, the "..."
 * button gets the DropdownMenu set. Upstream shipped
 * `context-menu-sub-trigger` without the `gap-2` that every other row in
 * both families carries, so "Add to playlist" had its icon jammed against
 * its label on right-click and looked correct from the button.
 *
 * Worth a test rather than just a fix: these files are generated, and
 * re-running the shadcn CLI to add or update a component rewrites them
 * wholesale. The fix would go back out silently, and a one-row spacing
 * difference inside a submenu is exactly what nobody re-checks.
 */

const UI = join(process.cwd(), "src/components/ui");

/** Icon-to-label spacing. Shared by every row, whatever its padding. */
const SPACING = ["flex", "items-center", "gap-2"];

/**
 * Rows the user reads as one column. Checkbox and radio rows are excluded
 * on purpose: they use `pl-8 pr-2` to leave room for the check indicator,
 * which is correct rather than a misalignment.
 */
const FLUSH_PADDING = ["px-2", "py-1.5"];

function classesForSlot(file: string, slot: string): string[] {
  const src = readFileSync(join(UI, file), "utf8");
  const m = src.match(
    new RegExp(
      `data-slot="${slot}"[\\s\\S]{0,1200}?className=\\{cn\\(\\s*(?://[^\\n]*\\n\\s*)*"([^"]*)"`,
    ),
  );
  if (!m) throw new Error(`no className found for data-slot="${slot}" in ${file}`);
  return m[1].split(/\s+/).filter(Boolean);
}

const ALL_ROWS: [string, string][] = [
  ["context-menu.tsx", "context-menu-item"],
  ["context-menu.tsx", "context-menu-checkbox-item"],
  ["context-menu.tsx", "context-menu-radio-item"],
  ["context-menu.tsx", "context-menu-sub-trigger"],
  ["dropdown-menu.tsx", "dropdown-menu-item"],
  ["dropdown-menu.tsx", "dropdown-menu-checkbox-item"],
  ["dropdown-menu.tsx", "dropdown-menu-radio-item"],
  ["dropdown-menu.tsx", "dropdown-menu-sub-trigger"],
];

const FLUSH_ROWS: [string, string][] = [
  ["context-menu.tsx", "context-menu-item"],
  ["context-menu.tsx", "context-menu-sub-trigger"],
  ["dropdown-menu.tsx", "dropdown-menu-item"],
  ["dropdown-menu.tsx", "dropdown-menu-sub-trigger"],
];

describe("menu rows align with each other", () => {
  it.each(ALL_ROWS)("%s / %s spaces its icon from its label", (file, slot) => {
    const cls = classesForSlot(file, slot);
    for (const token of SPACING) {
      expect(
        cls,
        `${slot} is missing "${token}", so its icon sits against its label while the rows around it do not`,
      ).toContain(token);
    }
  });

  it.each(FLUSH_ROWS)("%s / %s uses the shared padding", (file, slot) => {
    const cls = classesForSlot(file, slot);
    for (const token of FLUSH_PADDING) {
      expect(cls, `${slot} is missing "${token}"`).toContain(token);
    }
  });

  it("keeps the two families interchangeable, since one menu uses both", () => {
    // Any divergence shows up as the same menu looking different depending
    // on whether it was opened by right-click or by the "..." button.
    for (const [ctx, dd] of [
      ["context-menu-item", "dropdown-menu-item"],
      ["context-menu-sub-trigger", "dropdown-menu-sub-trigger"],
    ]) {
      const a = classesForSlot("context-menu.tsx", ctx);
      const b = classesForSlot("dropdown-menu.tsx", dd);
      const layout = (c: string[]) =>
        [...SPACING, ...FLUSH_PADDING].filter((t) => c.includes(t)).sort();
      expect(layout(a), `${ctx} and ${dd} lay out differently`).toEqual(
        layout(b),
      );
    }
  });
});
