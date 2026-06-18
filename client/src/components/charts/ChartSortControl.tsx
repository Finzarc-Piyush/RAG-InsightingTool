import { useId } from "react";
import { cn } from "@/lib/utils";
import type { ChartSortSpec } from "@/shared/chartSort";

/**
 * The "Sort by ▾" dropdown for bar/column charts. A single native <select>
 * (accessible, matches the existing Type/Layout toolbar controls) listing the
 * four combinations: value high→low / low→high and axis ascending / descending.
 * Stateless — the caller (chat / dashboard / pivot) owns the value + persistence
 * via `useChartSort`.
 */

const FALLBACK: ChartSortSpec = { by: "value", direction: "desc" };

type ComboKey = "value-desc" | "value-asc" | "category-asc" | "category-desc";

function toComboKey(s: ChartSortSpec | undefined): ComboKey {
  const v = s ?? FALLBACK;
  return `${v.by}-${v.direction}` as ComboKey;
}

function fromComboKey(k: ComboKey): ChartSortSpec {
  const [by, direction] = k.split("-") as [
    ChartSortSpec["by"],
    ChartSortSpec["direction"],
  ];
  return { by, direction };
}

export interface ChartSortControlProps {
  value: ChartSortSpec | undefined;
  onChange: (next: ChartSortSpec) => void;
  /** Axis name for nicer option labels, e.g. "Age". Falls back to "axis". */
  axisLabel?: string;
  className?: string;
}

export function ChartSortControl({
  value,
  onChange,
  axisLabel,
  className,
}: ChartSortControlProps) {
  const id = useId();
  const axis = (axisLabel ?? "").trim() || "axis";
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <label
        htmlFor={id}
        className="text-[11px] uppercase tracking-wide text-muted-foreground"
      >
        Sort by
      </label>
      <select
        id={id}
        data-testid="chart-sort-control"
        className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
        value={toComboKey(value)}
        onChange={(e) => onChange(fromComboKey(e.target.value as ComboKey))}
      >
        <option value="value-desc">Value (high → low)</option>
        <option value="value-asc">Value (low → high)</option>
        <option value="category-asc">{`By ${axis} (ascending)`}</option>
        <option value="category-desc">{`By ${axis} (descending)`}</option>
      </select>
    </div>
  );
}
