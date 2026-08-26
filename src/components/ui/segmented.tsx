import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";

const SPRING = {
  type: "spring" as const,
  duration: 0.25,
  bounce: 0.05,
};

export interface SegmentedOption<T extends string> {
  value: T;
  /** Plain text in the common case; a node when a segment needs an icon
   *  (e.g. a spinner while its count is still being computed). */
  label: React.ReactNode;
}

/**
 * Segmented value picker for settings rows. Sized and shaped to match
 * the adjacent buttons: the outer track shares the `outline` button's
 * surface (`h-8`, `rounded-md`, border + `bg-background`), and the
 * selected segment is a raised chip that reads like a pressed button.
 * Radio semantics — it picks a value, it doesn't switch panels.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  fullWidth,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  disabled?: boolean;
  /** Stretch across the container, options sharing the width evenly. */
  fullWidth?: boolean;
  className?: string;
}) {
  const shouldReduceMotion = useReducedMotion();
  const layoutId = useId();

  return (
    <div
      role="radiogroup"
      className={cn(
        // Track and thumb per the design: the same `--w050` / `--w070`
        // resting fill as the switch, with the selected segment raised
        // on `--w140` instead of tinted.
        //
        // The segment's radius is the track's minus the 2px padding
        // (10 - 2 = 8, i.e. `rounded-md` here, since `--radius` is 10px).
        // Matching the two made the inner corner bulge past the outer one.
        "inline-flex shrink-0 items-center gap-0.5 rounded-[10px] border border-w070 bg-w050 p-0.5",
        fullWidth && "flex w-full",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative flex h-7 items-center justify-center rounded-md px-4 text-[13px] whitespace-nowrap transition-colors duration-[140ms]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              fullWidth && "flex-1",
              active
                ? "font-semibold text-t1"
                : "font-medium text-t6 hover:text-t3",
            )}
          >
            {active && (
              <motion.span
                layout
                layoutId={layoutId}
                className="absolute inset-0 rounded-md bg-w140 shadow-[0_1px_2px_var(--k350),inset_0_1px_0_var(--w080)]"
                transition={shouldReduceMotion ? { duration: 0 } : SPRING}
              />
            )}
            <span className="relative z-10">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
