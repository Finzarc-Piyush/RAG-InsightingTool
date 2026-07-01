import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { BuilderDimension } from "@/lib/api/dashboards";
import { cn } from "@/lib/utils";

/**
 * Wave W11 (data-bound cards) · selection-only filter chain — "Dimension is
 * one-of Values" rows, chained AND (e.g. Channel = MT AND BrandCode = X).
 * Values come from the dimension's `topValues` — never free-typed. A
 * high-cardinality dimension (no topValues) is not offered as a filter.
 */

export interface CardFilter {
  column: string;
  values: Array<string | number>;
}

export function FilterChainEditor({
  dimensions,
  filters,
  onChange,
}: {
  dimensions: BuilderDimension[];
  filters: CardFilter[];
  onChange: (filters: CardFilter[]) => void;
}) {
  // Only low-cardinality categoricals (with a known value list) are filterable.
  const filterable = dimensions.filter((d) => d.hasTopValues && (d.values?.length ?? 0) > 0);

  const setRow = (i: number, next: CardFilter) =>
    onChange(filters.map((f, idx) => (idx === i ? next : f)));
  const removeRow = (i: number) => onChange(filters.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...filters, { column: "", values: [] }]);

  return (
    <div className="space-y-2">
      {filters.map((f, i) => {
        const dim = filterable.find((d) => d.column === f.column);
        return (
          <div key={i} className="rounded-brand-sm border border-border/60 p-2">
            <div className="flex items-center gap-2">
              <Select
                value={f.column || undefined}
                onValueChange={(col) => setRow(i, { column: col, values: [] })}
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue placeholder="Filter by…" />
                </SelectTrigger>
                <SelectContent>
                  {filterable.map((d) => (
                    <SelectItem key={d.column} value={d.column} className="text-xs">
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-shrink-0 text-muted-foreground"
                onClick={() => removeRow(i)}
                aria-label="Remove filter"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {dim ? (
              <ToggleGroup
                type="multiple"
                value={f.values.map(String)}
                onValueChange={(vals) =>
                  setRow(i, {
                    column: f.column,
                    // Map back to the original value type (number vs string).
                    values: (dim.values ?? [])
                      .filter((v) => vals.includes(String(v.value)))
                      .map((v) => v.value),
                  })
                }
                className="mt-2 flex flex-wrap justify-start gap-1"
              >
                {(dim.values ?? []).map((v) => (
                  <ToggleGroupItem
                    key={String(v.value)}
                    value={String(v.value)}
                    className={cn(
                      "h-6 rounded-full border border-border/60 px-2.5 text-[0.7rem]",
                      "data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                    )}
                  >
                    {String(v.value)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        onClick={addRow}
        disabled={filterable.length === 0}
        className="h-7 text-xs"
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add filter
      </Button>
    </div>
  );
}
