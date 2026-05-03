/**
 * Wave-FA6 · Captured-filter provenance banner for dashboards.
 *
 * Renders only when the dashboard was created while a session active filter
 * was set. The dashboard's chart data is already a snapshot of the filtered
 * slice — this banner tells the viewer *which* filter produced that slice so
 * the numbers can be interpreted correctly. It is read-only metadata; the
 * filter is not re-applied at view time (chart data is already filtered).
 */
import { Filter as FilterIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ActiveFilterSpec, ActiveFilterCondition } from "@/shared/schema";

function chipLabel(c: ActiveFilterCondition): string {
  if (c.kind === "in") {
    if (c.values.length === 0) return `${c.column} = (none)`;
    if (c.values.length === 1) return `${c.column} = ${c.values[0]}`;
    if (c.values.length <= 3) return `${c.column} ∈ {${c.values.join(", ")}}`;
    return `${c.column} ∈ ${c.values.length} values`;
  }
  if (c.kind === "range") {
    const lo = c.min ?? "";
    const hi = c.max ?? "";
    if (lo !== "" && hi !== "") return `${c.column} ∈ [${lo}, ${hi}]`;
    if (lo !== "") return `${c.column} ≥ ${lo}`;
    if (hi !== "") return `${c.column} ≤ ${hi}`;
    return c.column;
  }
  const f = c.from ?? "";
  const t = c.to ?? "";
  if (f && t) return `${c.column}: ${f} → ${t}`;
  if (f) return `${c.column} ≥ ${f}`;
  if (t) return `${c.column} ≤ ${t}`;
  return c.column;
}

export function CapturedFilterBanner({ spec }: { spec: ActiveFilterSpec }) {
  if (!spec.conditions || spec.conditions.length === 0) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs"
      data-testid="captured-filter-banner"
      role="note"
      aria-label="This dashboard was captured under an active filter"
    >
      <FilterIcon className="h-3.5 w-3.5 text-primary" />
      <span className="font-medium text-foreground">
        Captured with filter:
      </span>
      {spec.conditions.map((c) => (
        <Badge key={c.column} variant="secondary" className="text-[11px]">
          {chipLabel(c)}
        </Badge>
      ))}
      <span className="ml-auto text-muted-foreground">
        Numbers reflect the filtered slice at the time this dashboard was created.
      </span>
    </div>
  );
}
