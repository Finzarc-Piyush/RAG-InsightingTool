/**
 * SuggestedAlts — inline panel showing 1-3 alternative-mark suggestions
 * when the current chart violates a heuristic. WC2.5.
 *
 * Hidden when there are no suggestions, so users only see this UI
 * when there's a *reason* to consider switching marks.
 */

import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Suggestion } from "@/lib/charts/suggestedAlts";
import type { ChartV2Mark } from "@/shared/schema";

export interface SuggestedAltsProps {
  suggestions: Suggestion[];
  onApply: (mark: ChartV2Mark) => void;
  className?: string;
}

export function SuggestedAlts({
  suggestions,
  onApply,
  className,
}: SuggestedAltsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Suggested alternative chart types"
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px]",
        className,
      )}
    >
      <Lightbulb
        className="h-3.5 w-3.5 flex-shrink-0 text-primary"
        aria-hidden
      />
      <span className="font-medium text-foreground/80">Try:</span>
      {suggestions.map((s) => (
        <button
          key={s.mark}
          type="button"
          onClick={() => onApply(s.mark)}
          title={s.reason}
          className="inline-flex items-center rounded border border-primary/30 bg-card px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {s.mark}
        </button>
      ))}
    </div>
  );
}
