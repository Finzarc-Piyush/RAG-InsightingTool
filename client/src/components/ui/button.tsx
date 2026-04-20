import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Button primitive aligned with the brand guidebook.
 *
 * Visual changes from the pre-UX-2 baseline:
 *   - Radius moves from `rounded-md` (6px legacy) to `rounded-brand-md`
 *     (10px), the canonical brand button shape.
 *   - Focus ring switches from 1px ring to a 2px primary/40 ring with
 *     a 2px offset — a more confident accessibility cue.
 *   - Active press adds a 0.5px translate-y for tactility.
 *   - All colour + shadow transitions run on `duration-base ease-standard`.
 *   - Two new variants:
 *       • `subtle` — quiet tinted action (e.g. secondary composer buttons).
 *       • `gold`   — the one signature CTA per view (per the guidebook).
 *
 * Pre-existing variants (`default`, `destructive`, `outline`,
 * `secondary`, `ghost`) keep their current look so no consumer breaks.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-brand-md text-sm font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-base ease-standard",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "active:translate-y-[0.5px]",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "hover-elevate active-elevate-2",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border border-primary-border",
        destructive:
          "bg-destructive text-destructive-foreground border border-destructive-border",
        outline:
          // Shows the background color of whatever card / sidebar / accent
          // background it is inside of. Inherits current text color.
          "border [border-color:var(--button-outline)] shadow-xs active:shadow-none",
        secondary:
          "border bg-secondary text-secondary-foreground border-secondary-border",
        // Transparent border so toggling a visible border later does not shift
        // the layout of neighbours.
        ghost: "border border-transparent",
        // UX-2 additions ----------------------------------------------------
        // Quiet tinted action: sits on any surface, reads as secondary without
        // the full-chrome border of `outline`/`secondary`.
        subtle:
          "bg-muted/40 text-foreground border border-transparent hover:bg-muted/60",
        // Signature CTA — one per view. Uses the gold accent token.
        gold:
          "bg-[hsl(var(--accent-gold))] text-foreground border border-[hsl(var(--accent-gold))] hover:brightness-[0.97]",
      },
      // Heights are set as min-heights: sometimes the assistant renders long
      // labels; min-h lets the button grow instead of clipping.
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-brand-sm px-3 text-xs",
        lg: "min-h-10 rounded-brand-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
