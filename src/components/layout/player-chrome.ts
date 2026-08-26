/**
 * Shared chrome for the player's footer controls — the lyrics-source,
 * queue, volume and more buttons, which live in four different modules
 * but have to read as one row.
 *
 * The design system's footer button: 34px, 8px radius, resting `--t4`
 * on nothing, hover `--w090` / `--t1`. It deliberately hovers a step
 * heavier than the app-wide ghost button (`--w070`) because it sits on
 * the player card's own translucent fill rather than on the window.
 *
 * `playerIconButtonOn` is the toggled state (queue open, lyrics menu
 * open): the accent on a 14% accent tint. Hover is re-declared so the
 * neutral hover from the base class can't wash the tint out.
 */
export const playerIconButton =
  "size-8 rounded-md text-t4 hover:bg-w090 hover:text-t1 [&_svg]:size-4";

export const playerIconButtonOn =
  "bg-[rgba(var(--acc1rgb),0.14)] text-acc1 hover:bg-[rgba(var(--acc1rgb),0.14)] hover:text-acc1";
