/**
 * Wave WI4-panel · ExplainSlicePanel — the receiving end of the WI4
 * explain-this-slice event family.
 *
 * Sits below DashboardView via the Radix `Sheet` primitive (right-
 * side slide-in). When `event != null`, the panel is open and shows
 * a summary of the (chart, column, region) pin plus the active-filter
 * snapshot captured at brush-up time. The regenerated insight prose
 * will be fetched by the follow-on WI4-wire wave via `useInsightRegen`
 * against rows narrowed by `applyChartFilters → filterRowsByBrushRegion`;
 * until that lands, the body renders a placeholder pinning the
 * pipeline shape.
 *
 * Pure render component. Owns no state — the parent (DashboardView)
 * holds the event in state via the `EXPLAIN_SLICE_EVENT` listener,
 * passes it down, and closes the panel by clearing the event back
 * to `null`. Mirrors the WD3 `DrillThroughSheet` shape so the three
 * click-intent receivers stay structurally parallel:
 *
 *   - WD2 → no panel (cross-filter applies in-place to dashboard state)
 *   - WD3 → DrillThroughSheet (right slide-in with row table)
 *   - WI4 → ExplainSlicePanel  (right slide-in with regenerated insight)
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import type {
  BrushRegion,
  ExplainSliceEvent,
} from "../lib/explainSlice";

interface ExplainSlicePanelProps {
  /**
   * The captured explain-slice event, or `null` when the panel is
   * closed. The parent flips this to `null` to close (via
   * `onOpenChange(false)`).
   */
  event: ExplainSliceEvent | null;
  /**
   * Radix-style open-change handler. Called with `false` when the
   * user clicks the overlay, the close button, or presses Escape.
   * Parent should clear `event` to `null` so a re-open with the same
   * payload re-fires the slide-in animation.
   */
  onOpenChange: (open: boolean) => void;
}

/**
 * Format the active-filter snapshot for the panel body. Each filter
 * type (categorical / date / numeric) renders one human-readable
 * line. Local copy (rather than a shared util) because the WD3
 * sheet and the WI4 panel may diverge on filter display in future
 * waves (e.g. clickable filter chips on WI4-panel to refine the
 * slice further).
 */
function summariseFilters(filters: ActiveChartFilters | undefined): string[] {
  if (!filters) return [];
  const lines: string[] = [];
  for (const column of Object.keys(filters).sort()) {
    const sel = filters[column];
    if (!sel) continue;
    if (sel.type === "categorical") {
      lines.push(`${column} ∈ {${sel.values.join(", ")}}`);
    } else if (sel.type === "date") {
      lines.push(`${column} between ${sel.start} and ${sel.end}`);
    } else if (sel.type === "numeric") {
      lines.push(`${column} in [${sel.min}, ${sel.max}]`);
    }
  }
  return lines;
}

/**
 * Format a BrushRegion for the "Pinned slice" section. The three
 * region kinds get three different display shapes:
 *   - `numeric` → `[start, end]`
 *   - `temporal` → `<startISO> → <endISO>` (full ISO strings; the
 *     user can drill into the slice and see what window they're in,
 *     and the canonical form is more debuggable than a localised
 *     date)
 *   - `categorical` → comma-joined values, capped at 10 with a
 *     "… +N more" suffix so a 50-category brush doesn't blow the
 *     panel layout
 */
const MAX_CATEGORY_PREVIEW = 10;
function formatRegion(region: BrushRegion): string {
  if (region.kind === "numeric") {
    return `[${region.start}, ${region.end}]`;
  }
  if (region.kind === "temporal") {
    return `${new Date(region.startMs).toISOString()} → ${new Date(region.endMs).toISOString()}`;
  }
  // categorical
  const values = region.values;
  if (values.length <= MAX_CATEGORY_PREVIEW) {
    return values.join(", ");
  }
  const preview = values.slice(0, MAX_CATEGORY_PREVIEW).join(", ");
  const more = values.length - MAX_CATEGORY_PREVIEW;
  return `${preview}, … +${more} more`;
}

export function ExplainSlicePanel({ event, onOpenChange }: ExplainSlicePanelProps) {
  const open = event !== null;
  const filterLines = summariseFilters(event?.filters);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {event ? `Explain ${event.column}` : "Explain …"}
          </SheetTitle>
          <SheetDescription>
            {event
              ? "Regenerated insight for the brushed sub-region of this chart."
              : "No active brush selection."}
          </SheetDescription>
        </SheetHeader>

        {event ? (
          <div className="mt-6 space-y-4 text-sm">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pinned slice
              </h3>
              <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted-foreground">Chart</dt>
                <dd className="font-mono text-foreground">{event.chartId}</dd>
                <dt className="text-muted-foreground">Column</dt>
                <dd className="font-mono text-foreground">{event.column}</dd>
                <dt className="text-muted-foreground">Region</dt>
                <dd className="font-mono text-foreground">
                  <span className="mr-1 rounded bg-muted px-1 py-0.5 text-xs uppercase tracking-wide">
                    {event.region.kind}
                  </span>
                  {formatRegion(event.region)}
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Filter context at brush time
              </h3>
              {filterLines.length > 0 ? (
                <ul className="mt-2 space-y-1 font-mono text-xs text-foreground">
                  {filterLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No active filters — the regenerator sees the chart's
                  full backing rows, then narrows by the brushed
                  region only.
                </p>
              )}
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Regenerated insight
              </h3>
              {/*
                WI4-panel placeholder — the WI4-wire follow-on wave
                will replace this with a `useInsightRegen` call against
                rows narrowed by `applyChartFilters(rows, filters)` →
                `filterRowsByBrushRegion(…, region)`. The placeholder
                pins the pipeline shape so future-Claude can wire the
                hook with a single swap. The same pattern as
                WD3-sheet's placeholder → WD3-sheet-fetch's swap.
              */}
              <p className="mt-2 rounded border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                The regenerated insight for this brushed slice will
                appear here once the WI4-wire wave lands. The
                regenerator narrows rows via{" "}
                <code className="font-mono">applyChartFilters</code> →{" "}
                <code className="font-mono">filterRowsByBrushRegion</code>{" "}
                and pipes them into{" "}
                <code className="font-mono">useInsightRegen</code>.
              </p>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
