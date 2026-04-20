import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Input primitive.
 *
 * - Radius `rounded-brand-sm` (6px) — tighter than the 10px button so
 *   the text field reads as an "inside" element.
 * - Focus ring: 2px `primary/40` with 1px offset — subtler than the
 *   button ring so focused inputs do not feel as assertive as CTAs.
 * - Colour + ring transitions run on `duration-quick ease-standard`.
 * - Height stays 36px (`h-9`) to align with icon buttons.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-brand-sm border border-input bg-background px-3 py-2 text-base ring-offset-background",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "placeholder:text-muted-foreground",
          "transition-[border-color,box-shadow,background-color] duration-quick ease-standard",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:border-primary/60",
          "disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
