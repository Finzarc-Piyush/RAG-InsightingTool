import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Card primitive.
 *
 * Two variants:
 *   - default     — resting surface (`shadow-elev-1`, unchanged look to
 *                   avoid regressions across every modal / card body).
 *   - interactive — interactive surface with `shadow-elev-2` and a
 *                   hover lift (`-translate-y-0.5`). Uses
 *                   `bg-gradient-elevate` so the surface has a very
 *                   subtle vertical sheen without adding an accent.
 *
 * Consumers adopt `variant="interactive"` when the card is clickable or
 * represents a primary affordance (dashboard tile, draft card, chat
 * composer). Leave the variant unset to keep today's look.
 *
 * Guidebook §5 (elevation).
 */

type CardVariant = "default" | "interactive";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "shadcn-card rounded-xl border bg-card border-card-border text-card-foreground",
        variant === "interactive"
          ? [
              "shadow-elev-2 bg-gradient-elevate",
              "transition-[transform,box-shadow] duration-base ease-standard",
              "hover:-translate-y-0.5 hover:shadow-elev-3",
              "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
            ].join(" ")
          : "shadow-sm",
        className
      )}
      {...props}
    />
  )
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
}
