import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * UX-2 · Textarea primitive — matches the Input focus treatment so
 * fields and multi-line inputs feel like one family.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-brand-sm border border-input bg-background px-3 py-2 text-base ring-offset-background",
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
})
Textarea.displayName = "Textarea"

export { Textarea }
