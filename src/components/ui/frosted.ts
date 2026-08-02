/**
 * Frosted glass shared by every floating surface in the app: the chrome
 * dialogs (Settings, What's New, About, Report Issue) and the menus
 * (dropdown + right-click context menus).
 *
 * A translucent (0.7) sheet over a heavy backdrop blur. In dark mode
 * the fill sits a hair above --background (L 0.145 → 0.19) so it reads
 * as a dark grey surface rather than a pure-black slab, while the
 * remaining 30% lets the cover art's colour wash through the blur. The
 * blur goes past the dialog's original 40px to compensate: at this fill
 * a weaker blur lets high-contrast art (text on a cover, a bright
 * gradient) show through as shapes and eat the menu labels.
 *
 * The border is a touch brighter than the fill so the frosted edge
 * stays legible against the blurred art behind it.
 *
 * Consumers must NOT also set `bg-popover` / `bg-background`: those win
 * or lose by class order rather than by intent, so drop the opaque fill
 * entirely and compose this instead.
 */
export const frostedSurface =
  "border-black/10 bg-background/70 backdrop-blur-3xl dark:border-white/15 dark:bg-[oklch(0.19_0_0)]/70";

/**
 * Dim behind a modal dialog. Lighter than the shadcn default (0.5 →
 * 0.4) so more of the cover art's colour survives into the panel's
 * backdrop-blur.
 */
export const frostedOverlay = "bg-black/40";
