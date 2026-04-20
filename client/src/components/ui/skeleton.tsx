import { cn } from "@/lib/utils"

/**
 * UX-8 · Skeleton loader.
 *
 * Swaps the default `animate-pulse` (opacity fade in/out) for the brand
 * `brand-shimmer` keyframe — a diagonal gradient sweeps across the
 * surface every 1500ms. Reads as "the system is thinking," not
 * "everything is blinking."
 *
 * The shimmer is neutralised by the global `prefers-reduced-motion:
 * reduce` guard in client/src/index.css, which also aliases
 * `.animate-brand-shimmer` to `animation: none`. Users who opt out get
 * a static muted placeholder.
 */
function Skeleton({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-brand-sm bg-muted animate-brand-shimmer",
        className
      )}
      style={{
        backgroundImage:
          "linear-gradient(110deg, transparent 40%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 60%)",
        backgroundSize: "200% 100%",
        ...style,
      }}
      {...props}
    />
  )
}

export { Skeleton }
