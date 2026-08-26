import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Design-system field: a filled `--w050` box with a `--w120`
        // hairline that lifts on hover, and an accent border plus a soft
        // accent ring on focus. Filled rather than transparent so it
        // reads as an input on the frosted dialog surfaces.
        "h-10 w-full min-w-0 rounded-lg border border-w120 bg-w050 px-3 py-1 text-[13.5px] text-t2 transition-[color,background-color,border-color,box-shadow] duration-[140ms] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-t2 placeholder:text-tph disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "hover:border-w200 hover:bg-w080",
        "focus-visible:border-acc1 focus-visible:bg-w070 focus-visible:ring-[3px] focus-visible:ring-[rgba(var(--acc1rgb),0.18)]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
