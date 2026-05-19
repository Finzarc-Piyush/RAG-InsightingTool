/**
 * Wave WD3-sheet · DrillThroughSheet — the receiving end of the WD3
 * drill-through event family.
 *
 * Sits below DashboardView via the Radix `Sheet` primitive (right-
 * side slide-in). When `event != null`, the sheet is open and shows
 * a summary of the (chart, column, value) pin plus the active-filter
 * snapshot captured at click time. The underlying rows are fetched
 * from the upcoming WD3-server endpoint (`/api/dashboards/:id/drill`)
 * — until that lands, the body renders a placeholder that pins the
 * request shape so future-Claude can wire the fetch with a single
 * swap.
 *
 * Pure render component. Owns no state — the parent (DashboardView)
 * holds the event in state via the `DRILL_THROUGH_EVENT` listener,
 * passes it down, and closes the sheet by clearing the event back
 * to `null`. Mirrors the existing Radix-dialog pattern in
 * `DashboardView` (export / delete / add-sheet / share — all
 * controlled with `open` + `onOpenChange`).
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { DrillThroughEvent } from "../lib/drillThrough";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import { toFilterValue } from "../lib/crossFilter";

interface DrillThroughSheetProps {
  /**
   * The captured drill-through event, or `null` when the sheet is
   * closed. The parent flips this to `null` to close (via
   * `onOpenChange(false)`).
   */
  event: DrillThroughEvent | null;
  /**
   * Radix-style open-change handler. Called with `false` when the
   * user clicks the overlay, the close button, or presses Escape.
   * Parent should clear `event` to `null` so a re-open with the same
   * payload re-fires the slide-in animation.
   */
  onOpenChange: (open: boolean) => void;
}

/**
 * Format the active-filter snapshot for the placeholder body. Each
 * filter type (categorical / date / numeric) renders one
 * human-readable line. Used only inside the placeholder until
 * WD3-server replaces it with the real row list.
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

export function DrillThroughSheet({
  event,
  onOpenChange,
}: DrillThroughSheetProps) {
  const open = event !== null;
  const filterLines = summariseFilters(event?.filters);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {event ? `Drill into ${event.column}` : "Drill into …"}
          </SheetTitle>
          <SheetDescription>
            {event
              ? `Underlying rows for ${event.column} = ${toFilterValue(event.value)}.`
              : "No active drill request."}
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
                <dt className="text-muted-foreground">Value</dt>
                <dd className="font-mono text-foreground">
                  {toFilterValue(event.value)}
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Filter context at click time
              </h3>
              {filterLines.length > 0 ? (
                <ul className="mt-2 space-y-1 font-mono text-xs text-foreground">
                  {filterLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No active filters — the server returns the chart's full
                  backing rows.
                </p>
              )}
            </section>

            <section className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              Row fetch lands with the WD3-server endpoint
              (<span className="font-mono">/api/dashboards/:id/drill</span>).
              Until then this panel summarises the drill request shape.
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
