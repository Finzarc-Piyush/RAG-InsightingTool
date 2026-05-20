/**
 * W61-source-filter / W61-detail-extract · "Show only X" chip row above
 * each section's table on the admin semantic-model detail page. Extracted
 * from `AdminSemanticModelDetail.tsx` in W61-detail-extract to relieve
 * file-size pressure on the host before W61-add-delete grows it further.
 *
 * One global filter on the page (rather than per-table) because the
 * common workflow is "show me what I edited" applied across metrics +
 * dimensions + hierarchies uniformly — a per-table filter would force
 * the admin to click three filters to achieve the same effect. The
 * trade-off: clicking "User" on the metrics card also filters the
 * dimensions + hierarchies cards below; this is intentional and the
 * per-card count label disambiguates ("User (3)" on metrics, "User (12)"
 * on dimensions).
 *
 * Visual treatment: the *active* chip carries the source's badge
 * variant (matches the row badges so the active filter visually
 * "ties" to the entries it leaves visible); inactive chips render
 * as an outline so the row reads as "pick a filter". The "All"
 * sentinel uses the outline variant even when active so it doesn't
 * compete with the source variants — the absence of source-tinting
 * itself signals "no filter applied".
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getSourceBadgeVariant } from "../lib/semanticModelSourceBadge";
import {
  SOURCE_FILTER_ORDER,
  getFilterLabel,
  type SemanticEntryFilter,
} from "../lib/semanticModelSourceFilter";

export interface SourceFilterChipsProps {
  active: SemanticEntryFilter;
  counts: Readonly<Record<SemanticEntryFilter, number>>;
  onChange: (next: SemanticEntryFilter) => void;
}

export function SourceFilterChips({
  active,
  counts,
  onChange,
}: SourceFilterChipsProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Filter entries by source"
    >
      {SOURCE_FILTER_ORDER.map((f) => {
        const isActive = f === active;
        const variant =
          isActive && f !== "all" ? getSourceBadgeVariant(f) : "outline";
        return (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            aria-pressed={isActive}
            className={cn(
              "transition-opacity",
              isActive ? "" : "opacity-70 hover:opacity-100",
            )}
          >
            <Badge
              variant={variant}
              className="px-2 py-0 h-5 text-[11px] font-medium cursor-pointer"
            >
              {getFilterLabel(f)} ({counts[f]})
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
