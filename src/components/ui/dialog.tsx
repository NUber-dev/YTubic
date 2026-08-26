"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { frostedOverlay, frostedSurface } from "@/components/ui/frosted"

// Same glass the menus use — see components/ui/frosted.ts.
const frostedDialogOverlay = frostedOverlay
const frostedDialogPanel = frostedSurface

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // Covers the whole window, title bar included — the app menu,
        // sidebar toggle and history arrows are as inert as the rest of
        // the app while a dialog is up, and should read that way. The
        // minimize / maximize / close cluster is the exception: it lifts
        // itself above this (see `WINDOW_CHROME_ATTR` below).
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-xs data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Marks window chrome that has to keep working while a dialog is open:
 * the minimize / maximize / close cluster, and the title bar's drag
 * strip. Both sit above the overlay and opt back into pointer events
 * (Radix pins `pointer-events: none` on the body) — see `top-bar.tsx`.
 *
 * Moving or resizing the window is a window action, not a dismissal, so
 * `DialogContent` below ignores outside interactions that start in here
 * instead of closing the dialog. Without that, dragging the title bar
 * closed the dialog and the aborted gesture selected the page text
 * underneath.
 */
export const WINDOW_CHROME_ATTR = "data-window-chrome";

function isWindowChrome(target: EventTarget | null): boolean {
  return (
    target instanceof Element && !!target.closest(`[${WINDOW_CHROME_ATTR}]`)
  );
}

function DialogContent({
  className,
  overlayClassName,
  children,
  showCloseButton = true,
  onInteractOutside,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  // Per-dialog overlay tint/blur override. tailwind-merge lets a caller
  // pass e.g. `bg-black/40` to dim less than the default `bg-black/50`
  // (the settings popup does this so more of the cover's colour bleeds
  // through its backdrop) without affecting every other dialog.
  overlayClassName?: string
}) {
  const contentRef = React.useRef<HTMLDivElement>(null)

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        ref={contentRef}
        // Radix focuses the first focusable control on open, which paints
        // a focus ring on whatever happens to be first — a text field, a
        // close button, a tab. Focus the panel itself instead: the focus
        // trap and Escape still work, Tab still walks the dialog, and
        // nothing starts out highlighted. The panel is focusable because
        // Radix's FocusScope gives it `tabIndex={-1}`.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          contentRef.current?.focus({ preventScroll: true })
          onOpenAutoFocus?.(e)
        }}
        onInteractOutside={(e) => {
          if (isWindowChrome(e.target)) e.preventDefault();
          onInteractOutside?.(e);
        }}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  frostedDialogOverlay,
  frostedDialogPanel,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
