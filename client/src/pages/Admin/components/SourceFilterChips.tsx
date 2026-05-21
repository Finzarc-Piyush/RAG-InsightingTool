/**
 * W61-source-filter / W61-detail-extract · "Show only X" chip row above
 * each section's table on the admin semantic-model detail page. Extracted
 * from `AdminSemanticModelDetail.tsx` in W61-detail-extract to relieve
 * file-size pressure on the host before W61-add-delete grew it further.
 *
 * Originally one global filter on the page (rather than per-table) because
 * the common workflow is "show me what I edited" applied across metrics +
 * dimensions + hierarchies uniformly — a per-table filter would force the
 * admin to click three filters to achieve the same effect. The trade-off:
 * clicking "User" on the metrics card also filtered the dimensions +
 * hierarchies cards below; this was intentional and the per-card count
 * label disambiguated ("User (3)" on metrics, "User (12)" on dimensions).
 *
 * Wave W61-per-section-filter · the chips now surface a per-section
 * override path: plain-click is still the global re-sync (sets the
 * synced filter across all three cards, clearing any existing override
 * — single predictable exit path from override mode); shift-click sets
 * only THIS card's section override. The `onChange` callback widens to
 * `(next, modifier)` so the host's pure reducer
 * (`applyChipClick`) can branch on the modifier flag without needing
 * to look at React's synthetic event object. An optional
 * `isOverridden` boolean prop drives a small "Overridden" italic
 * muted-foreground hint at the end of the chip row so the override
 * state is discoverable without comparing values manually.
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
  /**
   * Fired on chip click. `modifier` is true when the admin shift-
   * clicked (per-section override path); false on plain click (global
   * re-sync path). The host's pure `applyChipClick` reducer routes the
   * two branches.
   */
  onChange: (next: SemanticEntryFilter, modifier: boolean) => void;
  /**
   * W61-per-section-filter · true when this section currently has a
   * per-section override (i.e. its effective filter is NOT inherited
   * from the global). Drives a small "Overridden" hint at the end of
   * the chip row so the state is discoverable; the hint is muted so
   * it doesn't compete with the chips themselves. Optional for
   * backward compatibility with future consumers that don't yet wire
   * the override state.
   */
  isOverridden?: boolean;
}

export function SourceFilterChips({
  active,
  counts,
  onChange,
  isOverridden,
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
            onClick={(e) => onChange(f, e.shiftKey)}
            aria-pressed={isActive}
            title={
              isActive
                ? `${getFilterLabel(f)} (shift-click to scope to this section)`
                : `${getFilterLabel(f)} — click to set across all sections, shift-click for this section only`
            }
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
      {isOverridden ? (
        <span
          className="text-[10px] italic text-muted-foreground ml-1"
          title="Section-only filter active. Click any chip without shift to re-sync this section to the global filter."
        >
          (overridden)
        </span>
      ) : null}
    </div>
  );
}
