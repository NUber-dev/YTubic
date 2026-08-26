import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Variants follow the design-system recipes (see the palette block in
// index.css). Colours come from the raw `t#` / `w###` / `acc#` ramp
// rather than the shadcn semantic tokens, so a button reads the same
// over the blurred album art as it does on an opaque settings panel.
//
// Transitions are 140ms and scoped to the properties that actually
// change, matching the handoff — `transition-all` made every layout
// property animate on hover.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,filter] duration-[140ms] ease-out focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Primary accent (Play, modal confirm). The fill is a radial
        // gradient rather than a flat accent so the top edge catches a
        // highlight; hover brightens it and lifts the accent glow
        // instead of shifting the hue.
        default:
          "border border-transparent bg-[radial-gradient(circle_at_50%_0%,var(--acc5),var(--acc1)_62%)] font-semibold text-white shadow-[0_5px_16px_-5px_rgba(var(--acc1rgb),0.13),inset_0_1px_1px_var(--w170)] hover:brightness-[1.16] hover:shadow-[0_8px_22px_-5px_rgba(var(--acc1rgb),0.34),inset_0_1px_1px_var(--w240)]",
        // Danger (Clear cache, Sign out). Accent hue, but hollow — the
        // solid accent is reserved for the primary action.
        destructive:
          "border border-[rgba(var(--acc1rgb),0.38)] bg-[rgba(var(--acc1rgb),0.10)] text-acc2 hover:border-[rgba(var(--acc1rgb),0.5)] hover:bg-[rgba(var(--acc1rgb),0.16)]",
        // Quiet filled button — the settings-panel workhorse.
        outline:
          "border border-w090 bg-w050 text-t3 hover:bg-w090 hover:text-t1",
        // Filled companion to `default` (Shuffle next to Play): same
        // geometry and weight, neutral fill.
        secondary:
          "border border-w160 bg-w100 font-semibold text-t1 hover:border-w240 hover:bg-w150",
        ghost: "text-t4 hover:bg-w070 hover:text-t1",
        link: "text-acc1 underline-offset-4 hover:underline",
      },
      size: {
        // Text-bearing variants: `leading-none` collapses the default
        // text line-height down to 1, and an asymmetric padding-bottom
        // (1–2px more than padding-top) shifts content up by ~1px via
        // items-center. Together they put the cap-area of the label on
        // the geometric center of the button — Segoe UI (and most
        // sans-serifs) leave more empty space below the baseline than
        // above the cap, which otherwise drags the text optically low.
        // Icon-only variants stay untouched: a centered glyph in those
        // is already optically centered.
        default: "h-9 px-4 pt-2 pb-2.5 leading-none has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 pb-px text-xs leading-none has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-[9px] px-3 pb-0.5 leading-none has-[>svg]:px-2.5",
        lg: "h-10 px-6 pb-0.5 leading-none has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[9px]",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
