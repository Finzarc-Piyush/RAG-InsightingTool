"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Tooltip primitive.
 *
 * Default delay bumps to 350ms — premium products let the user move
 * without a chaser. Content switches to `shadow-elev-3`, the brand
 * caption size (11/16 tracked at 0.01em), and `rounded-brand-sm` so
 * tooltips feel like typography, not chrome.
 *
 * The rest of the Radix animation data-attrs are kept as-is so
 * tailwindcss-animate still handles enter/exit.
 */

const TooltipProvider: React.FC<
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>
> = ({ delayDuration = 350, ...props }) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
)

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-brand-sm border border-popover-border bg-popover px-2.5 py-1.5",
      "text-[11px] leading-4 tracking-[0.01em] text-popover-foreground",
      "shadow-elev-3",
      "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
      "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      "origin-[--radix-tooltip-content-transform-origin]",
      className
    )}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
