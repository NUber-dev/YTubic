/**
 * Shared chrome for the two menu families — the dropdown menus (window
 * menu, player more-menu, lyrics source, playlist actions) and the
 * right-click context menus. They are separate Radix primitives with
 * separate wrappers, so without this they drift apart.
 *
 * The panel follows the design handoff: a 12px glass sheet on `glass3`
 * with a 22px blur, one step less transparent than the dialogs' own
 * frosting because a menu is small and sits directly over cover art.
 * Submenus go a step denser again (`glass4`) so a stack of two panels
 * still separates.
 *
 * Radius nesting: 12px panel minus 5px padding leaves 7px for the item,
 * rounded up to the 8px step (`rounded-md`).
 */
export const MENU_PANEL =
  "z-50 min-w-[8rem] rounded-[12px] border border-w100 bg-glass3 p-[5px] " +
  "text-t3 backdrop-blur-[22px] backdrop-saturate-[1.4] " +
  "shadow-[0_18px_40px_-12px_var(--k850)]";

/* Same sheet as the parent: a denser fill read as a different surface
   rather than as a second panel of the same menu. Depth comes from the
   shadow instead. */
export const MENU_SUBPANEL = MENU_PANEL;

/** Open/close transitions, identical for both families. */
export const MENU_MOTION =
  "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 " +
  "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 " +
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 " +
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

/**
 * A row. Icons rest at `--t5` and lift to the label's colour with it,
 * so the whole row reads as one object on hover rather than a bright
 * glyph next to dim text.
 */
export const MENU_ITEM =
  "relative flex cursor-pointer items-center gap-[11px] rounded-md px-2.5 py-1.5 " +
  "text-[13.5px] outline-hidden transition-colors duration-[140ms] select-none " +
  "focus:bg-w070 focus:text-t1 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 " +
  "[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-t5 " +
  "focus:[&_svg:not([class*='text-'])]:text-t3";

/**
 * Destructive rows (Quit, Sign out, Remove from Liked, cache wipes).
 * shadcn's treatment: red label at rest, soft red wash on hover instead
 * of the neutral one, so the row stays legible but never shouts.
 */
export const MENU_ITEM_DESTRUCTIVE =
  "data-[variant=destructive]:text-destructive " +
  "data-[variant=destructive]:focus:bg-destructive/10 " +
  "data-[variant=destructive]:focus:text-destructive " +
  "dark:data-[variant=destructive]:focus:bg-destructive/20 " +
  "data-[variant=destructive]:*:[svg]:text-destructive!";

/**
 * Checkbox and radio rows. The tick sits at the trailing edge rather
 * than in a left gutter: the rows carry their own leading icons, and a
 * gutter both pushed those out of line with the plain rows above and
 * ate the width these submenus need.
 */
export const MENU_CHOICE_ITEM =
  "relative flex cursor-pointer items-center gap-[11px] whitespace-nowrap rounded-md px-2.5 py-1.5 " +
  "text-[13.5px] outline-hidden transition-colors duration-[140ms] select-none " +
  "focus:bg-w070 focus:text-t1 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 " +
  "[&_svg:not([class*='text-'])]:text-t5 focus:[&_svg:not([class*='text-'])]:text-t3";

/** Inset by the panel's own padding rather than bled to the edges. */
export const MENU_SEPARATOR = "mx-1 my-[5px] h-px bg-w080";

export const MENU_LABEL =
  "px-2.5 py-1.5 text-[13px] font-semibold text-t2 data-[inset]:pl-8";

export const MENU_SHORTCUT = "ml-auto text-[12px] text-t7";
