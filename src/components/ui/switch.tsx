import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Design-system switch: a 44x26 track, off on the same
        // `--w050` / `--w070` fill every other resting control uses, on
        // in the accent with a dark hairline and an inner highlight so
        // the fill reads as lit rather than flat.
        "peer inline-flex h-[26px] w-11 shrink-0 items-center rounded-full border transition-[background-color,border-color,box-shadow] duration-[180ms] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=unchecked]:border-w070 data-[state=unchecked]:bg-w050 data-[state=checked]:border-k180 data-[state=checked]:bg-acc1 data-[state=checked]:shadow-[inset_0_1px_1px_var(--w220)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // White in both themes and both states — it's the knob of a
          // physical switch, not a themed surface. The hairline ring
          // keeps it off a light track.
          //
          // On the accent fill the resting shadow reads as a hard dark
          // seam, so the checked state trades depth for blur: a wider,
          // lighter drop and a fainter ring.
          //
          // Travel is derived, not a grid step: the track's 1px borders
          // leave 42px inside, so a 20px knob inset 2px on both ends has
          // exactly 18px to cross.
          "pointer-events-none ml-0.5 block size-5 rounded-full bg-white shadow-[0_1px_2px_var(--k400),0_0_0_0.5px_rgba(0,0,0,0.06)] data-[state=checked]:shadow-[0_1px_3px_var(--k240),0_0_0_0.5px_rgba(0,0,0,0.04)] ring-0 transition-transform duration-[180ms] [transition-timing-function:cubic-bezier(.32,.72,0,1)] data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
