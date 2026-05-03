import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { facetColumnHeaderLabelForColumn } from "@/lib/temporalFacetDisplay";
import type { TemporalFacetColumnMeta } from "@/shared/schema";
import type { FilterSelections } from "@/lib/pivot/types";

export interface PivotFilterChipsProps {
  filterFields: string[];
  filterSelections: FilterSelections;
  distinctsByField: Record<string, string[]>;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  onClearField: (field: string) => void;
  onClearAll: () => void;
}

function chipLabel(values: string[], total: number, label: string): string {
  if (values.length === 0) return `${label} = (none)`;
  if (values.length === 1) return `${label} = ${values[0]}`;
  if (values.length <= 3) return `${label} ∈ {${values.join(", ")}}`;
  return `${label} ∈ ${values.length} of ${total}`;
}

export function PivotFilterChips({
  filterFields,
  filterSelections,
  distinctsByField,
  temporalFacetColumns,
  onClearField,
  onClearAll,
}: PivotFilterChipsProps) {
  const activeChips = filterFields
    .map((f) => {
      const sel = filterSelections[f];
      const distincts = distinctsByField[f] ?? [];
      if (!sel) return null;
      if (distincts.length === 0) return null;
      const allSelected =
        sel.size === distincts.length && distincts.every((v) => sel.has(v));
      if (allSelected) return null;
      const values = distincts.filter((v) => sel.has(v));
      return { field: f, values, total: distincts.length };
    })
    .filter((x): x is { field: string; values: string[]; total: number } => Boolean(x));

  if (activeChips.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 mb-2 rounded-md border border-border/60 bg-primary/5 shrink-0"
      data-testid="pivot-filter-chips"
    >
      <span className="text-xs font-medium text-muted-foreground">Pivot filters:</span>
      {activeChips.map((c) => {
        const label = facetColumnHeaderLabelForColumn(c.field, temporalFacetColumns ?? []);
        return (
          <Badge
            key={c.field}
            variant="secondary"
            className="flex items-center gap-1 pl-2 pr-1 text-xs"
          >
            <span>{chipLabel(c.values, c.total, label)}</span>
            <button
              type="button"
              onClick={() => onClearField(c.field)}
              className="ml-1 rounded p-0.5 hover:bg-foreground/10"
              aria-label={`Clear filter on ${label}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClearAll}
        className="ml-auto h-6 px-2 text-xs"
      >
        Clear all
      </Button>
    </div>
  );
}
