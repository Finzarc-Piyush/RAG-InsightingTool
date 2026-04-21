import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Badge primitive.
 *
 * Shape flipped to `rounded-full` (full pill), typography to tabular
 * numerics so a chip like "-23.4%" reads as one figure. New `gold`
 * variant is the canonical shape for magnitudes / signature callouts
 * (one per view, per the guidebook). Pre-existing variants keep their
 * look so no consumer breaks.
 */
const badgeVariants = cva(
  [
    "whitespace-nowrap inline-flex items-center gap-1",
    "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
    "[font-variant-numeric:tabular-nums] [font-feature-settings:'tnum']",
    "transition-colors duration-quick ease-standard",
    "focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background",
    "hover-elevate",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-xs",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-xs",
        outline: "border [border-color:var(--badge-outline)] shadow-xs",
        // UX-2 addition — signature accent for magnitudes pills + sheet
        // highlights. Gold bg, ink text, thin matched border.
        gold:
          "border border-[hsl(var(--accent-gold))] bg-[hsl(var(--accent-gold)/0.15)] text-foreground",
        // UX-2 addition — positive numeric deltas. Tokenised via the
        // `surface-positive` utility already in index.css.
        success:
          "border border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants }
