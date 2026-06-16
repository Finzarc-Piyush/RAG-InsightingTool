"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { ErrorBoundary } from "@/components/ErrorBoundary"

/**
 * Wave R27 · compact in-dialog error fallback. A render error inside any dialog
 * body shows this instead of crashing the whole app; the Close button (outside
 * the boundary) still works so the user is never trapped. Includes a
 * DialogTitle so Radix's a11y requirement is met even in the error state.
 */
function DialogErrorFallback() {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-8 text-center">
      <DialogPrimitive.Title className="text-base font-semibold">
        Something went wrong
      </DialogPrimitive.Title>
      <p className="text-sm text-muted-foreground">
        This panel hit an unexpected error. Close it and try again.
      </p>
    </div>
  )
}

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // UX-2 · softer, blurred overlay instead of the default black/80.
      // `240 6% 10%` tracks the foreground neutral so the tint is cool
      // in light mode and naturally deeper in dark mode.
      "fixed inset-0 z-50 bg-[hsl(240_6%_10%/0.35)] backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /**
   * FE-7 · optional accessible name for dialogs that don't render their own
   * visible <DialogTitle>. When supplied, it's rendered as a visually-hidden
   * title. Typed `string` to stay compatible with the inherited HTML `title`
   * attribute. Sighted-user output is unchanged either way.
   */
  title?: string
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, title, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // UX-2 · brand-xl radius, elev-4 shadow, standard entrance
        // animation inherited from tailwindcss-animate.
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 duration-200",
        "rounded-brand-xl shadow-elev-4",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className
      )}
      {...props}
    >
      <ErrorBoundary fallback={<DialogErrorFallback />}>{children}</ErrorBoundary>
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
      {/*
        FE-7 · a11y guarantee. Radix logs a console warning and leaves the
        dialog without an accessible name when no <DialogTitle> exists. This
        visually-hidden fallback gives every dialog a name. It renders LAST so
        that callers who DO pass their own <DialogTitle> in `children` keep
        labelling the dialog — every DialogTitle shares Radix's single
        `titleId`, and aria-labelledby resolves to the first matching element
        in DOM order, so a real title always wins over this fallback. The
        `sr-only` class (already used by the Close button above) hides it from
        sighted users, so visual output is unchanged.
      */}
      <DialogPrimitive.Title className="sr-only">
        {title ?? "Dialog"}
      </DialogPrimitive.Title>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
