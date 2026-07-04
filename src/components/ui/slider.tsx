"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Half-width of the visible break around the thumb. The active fill
// stops `THUMB_GAP` before the thumb's center and the inactive piece
// resumes `THUMB_GAP` after it, leaving ~5px of empty space on each
// side of the 6px-thick thumb. Rendering the track as two separately
// rounded pills (instead of masking a single bar) keeps the cut ends
// nicely radiused, matching the YouTube/Joji reference.
const THUMB_GAP = 8

// Half of the thumb's thickness in px (w-1.5 / h-1.5 → 6px → 3px half).
// Radix shifts the thumb inward by this amount near the value
// extremes so it doesn't poke out of the track; we mirror that shift
// so the break stays centered on the thumb's *actual* on-screen
// position, not on the raw value percentage.
const THUMB_HALF_PX = 3

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  const range = max - min || 1
  const thumbPct =
    _values.length > 0 ? ((_values[0] - min) / range) * 100 : 0
  const isVertical = props.orientation === "vertical"
  // Same in-bounds clamp Radix applies: at 0% push the thumb inward
  // by +half, at 100% by -half, linear in between.
  const thumbOffsetPx = (THUMB_HALF_PX * (50 - thumbPct)) / 50
  const centerExpr = `calc(${thumbPct}% + ${thumbOffsetPx}px)`
  const activeSize = `calc(${centerExpr} - ${THUMB_GAP}px)`
  const inactiveStart = `calc(${centerExpr} + ${THUMB_GAP}px)`

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full cursor-pointer touch-none items-center select-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        // Pad the pointer-event area 4px past the visible track on the
        // axis perpendicular to the slider — easier to click slightly
        // above/below the 6px bar without changing its visual footprint.
        // `::before` overlays the Root's box (and 4px outside it on the
        // perpendicular axis) and bubbles pointer events to the Root,
        // where Radix's handlers translate clientX/Y into a value.
        "before:absolute before:content-['']",
        "data-[orientation=horizontal]:before:-inset-y-2 data-[orientation=horizontal]:before:inset-x-0",
        "data-[orientation=vertical]:before:-inset-x-2 data-[orientation=vertical]:before:inset-y-0",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          "relative grow data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
        )}
      >
        {/* Active (filled) pill — grows from the start to the thumb gap. */}
        <div
          data-slot="slider-range"
          aria-hidden
          className={cn(
            "absolute rounded-full bg-primary",
            isVertical ? "inset-x-0 bottom-0" : "inset-y-0 left-0"
          )}
          style={isVertical ? { height: activeSize } : { width: activeSize }}
        />
        {/* Inactive pill — starts after the thumb gap, runs to the end.
            Keeps the `slider-track` data-slot so existing
            `[&_[data-slot=slider-track]]:bg-white/20` overrides target
            the visible inactive bar. */}
        <div
          data-slot="slider-track"
          aria-hidden
          className={cn(
            "absolute rounded-full bg-muted",
            isVertical ? "inset-x-0 top-0" : "inset-y-0 right-0"
          )}
          style={
            isVertical
              ? { bottom: inactiveStart }
              : { left: inactiveStart }
          }
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="block shrink-0 rounded-full bg-white shadow-[0_0_3px_rgba(255,255,255,0.35),0_0_8px_rgba(255,255,255,0.15)] transition-shadow hover:shadow-[0_0_5px_rgba(255,255,255,0.5),0_0_12px_rgba(255,255,255,0.25)] focus-visible:shadow-[0_0_5px_rgba(255,255,255,0.5),0_0_12px_rgba(255,255,255,0.25)] focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[orientation=horizontal]:h-5 data-[orientation=horizontal]:w-1.5 data-[orientation=vertical]:h-1.5 data-[orientation=vertical]:w-5"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
