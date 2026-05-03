/**
 * Wave-FA4 · Active filter chip strip.
 *
 * Renders above the chat scroll area when an active filter is set. Each chip
 * shows one condition (`Region ∈ {North, South}`, `Sales ≥ 100`, etc.) and
 * dismissing the chip removes only that one condition. This makes filtered
 * state impossible to miss without taking up a full message bubble.
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ActiveFilterCondition } from "@/shared/schema";

export interface ActiveFilterChipsProps {
  conditions: ActiveFilterCondition[];
  totalRows: number;
  filteredRows: number;
  onRemoveCondition: (column: string) => void;
  onClearAll: () => void;
}

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
  // dateRange
  const f = c.from ?? "";
  const t = c.to ?? "";
  if (f && t) return `${c.column}: ${f} → ${t}`;
  if (f) return `${c.column} ≥ ${f}`;
  if (t) return `${c.column} ≤ ${t}`;
  return c.column;
}

export function ActiveFilterChips({
  conditions,
  totalRows,
  filteredRows,
  onRemoveCondition,
  onClearAll,
}: ActiveFilterChipsProps) {
  if (conditions.length === 0) return null;
  const isEmpty = filteredRows === 0;
  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 ${
        isEmpty ? "bg-destructive/5" : "bg-primary/5"
      }`}
      data-testid="active-filter-chips"
    >
      <span className="text-xs font-medium text-muted-foreground">
        Filter:
      </span>
      {conditions.map((c) => (
        <Badge
          key={c.column}
          variant={isEmpty ? "destructive" : "secondary"}
          className="flex items-center gap-1 pl-2 pr-1 text-xs"
        >
          <span>{chipLabel(c)}</span>
          <button
            type="button"
            onClick={() => onRemoveCondition(c.column)}
            className="ml-1 rounded p-0.5 hover:bg-foreground/10"
            aria-label={`Remove filter on ${c.column}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <span
        className={`ml-auto text-xs tabular-nums ${
          isEmpty ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {filteredRows.toLocaleString()} of {totalRows.toLocaleString()} rows
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="h-6 px-2 text-xs"
      >
        Clear all
      </Button>
    </div>
  );
}
