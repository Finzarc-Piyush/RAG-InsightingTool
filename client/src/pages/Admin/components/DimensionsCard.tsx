/**
 * W61-host-extract · `DimensionsCard` — the "Dimensions" section of the
 * admin semantic-model viewer (`AdminSemanticModelDetail.tsx`). Extracted
 * verbatim so the host can shed ~165 LOC (DimensionRow + the card JSX).
 *
 * Exports `TEMPORAL_GRAIN_AUTO` so the host's `handleTemporalGrainChange`
 * can map the sentinel back to `undefined` at the save boundary (Radix
 * Select can't carry empty-string values; the `__auto__` sentinel maps
 * to "let the agent's `temporalFacetColumns` derivation pick the grain
 * from data"). Co-locating the sentinel with the option list that
 * defines it keeps the source-of-truth in one file.
 */

import { Plus } from "lucide-react";
import type { SemanticDimension } from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  validateDescription,
  validateLabel,
} from "../lib/semanticModelEditValidation";
import {
  countEntriesBySource,
  filterEntriesBySource,
  type SemanticEntryFilter,
} from "../lib/semanticModelSourceFilter";
import { SourceFilterChips } from "./SourceFilterChips";
import {
  EditableSelect,
  EditableText,
  ExposedToggle,
  RowDeleteButton,
  SourceBadge,
} from "./semanticModelCells";

const DIMENSION_KIND_OPTIONS = [
  { value: "categorical", label: "Categorical" },
  { value: "temporal", label: "Temporal" },
  { value: "numeric_binned", label: "Numeric (binned)" },
  { value: "geo", label: "Geo" },
] as const satisfies ReadonlyArray<{
  value: SemanticDimension["kind"];
  label: string;
}>;

/**
 * `temporalGrain` is `.optional()` on the schema; Radix Select can't
 * carry an empty-string value, so a `__auto__` sentinel maps to
 * `undefined` at the save boundary (lets the agent's
 * `temporalFacetColumns` derivation still pick the grain from data).
 */
export const TEMPORAL_GRAIN_AUTO = "__auto__" as const;
const TEMPORAL_GRAIN_OPTIONS = [
  { value: TEMPORAL_GRAIN_AUTO, label: "Auto (let agent derive)" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
] as const;

function DimensionRow({
  d,
  saving,
  deletePending,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditKind,
  onEditTemporalGrain,
  onDelete,
}: {
  d: SemanticDimension;
  saving: boolean;
  deletePending: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditKind: (next: SemanticDimension["kind"]) => void;
  onEditTemporalGrain: (next: string) => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-foreground">{d.name}</div>
          <SourceBadge source={d.source} />
        </div>
        <EditableText
          value={d.label}
          onSave={onEditLabel}
          validate={validateLabel}
          disabled={saving}
          ariaLabel={`Edit label for dimension ${d.name}`}
        />
        <EditableText
          value={d.description ?? ""}
          onSave={onEditDescription}
          validate={validateDescription}
          disabled={saving}
          ariaLabel={`Edit description for dimension ${d.name}`}
          multiline
          placeholder="Description (shown to the planner)…"
        />
      </td>
      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
        {d.column}
      </td>
      <td className="py-3 px-4 min-w-[180px] space-y-2">
        <EditableSelect
          value={d.kind}
          options={DIMENSION_KIND_OPTIONS}
          onSave={onEditKind}
          disabled={saving}
          ariaLabel={`Edit kind for dimension ${d.name}`}
        />
        {d.kind === "temporal" ? (
          <EditableSelect
            value={d.temporalGrain ?? TEMPORAL_GRAIN_AUTO}
            options={TEMPORAL_GRAIN_OPTIONS}
            onSave={onEditTemporalGrain}
            disabled={saving}
            ariaLabel={`Edit temporal grain for dimension ${d.name}`}
          />
        ) : null}
      </td>
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={d.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${d.label} exposed`}
        />
      </td>
      <td className="py-3 px-4">
        <RowDeleteButton
          onDelete={onDelete}
          disabled={saving || deletePending}
          ariaLabel={`Delete dimension ${d.name}`}
        />
      </td>
    </tr>
  );
}

export interface DimensionsCardProps {
  dimensions: SemanticDimension[];
  sourceFilter: SemanticEntryFilter;
  onSourceFilterChange: (next: SemanticEntryFilter) => void;
  saving: boolean;
  deletePending: boolean;
  addDisabled: boolean;
  onAdd: () => void;
  onToggleExposed: (dimensionName: string, next: boolean) => void;
  onEditLabel: (dimensionName: string, next: string) => void;
  onEditDescription: (dimensionName: string, next: string) => void;
  onEditKind: (
    dimensionName: string,
    next: SemanticDimension["kind"],
  ) => void;
  onEditTemporalGrain: (dimensionName: string, next: string) => void;
  onRequestDelete: (dimensionName: string) => void;
}

export function DimensionsCard({
  dimensions,
  sourceFilter,
  onSourceFilterChange,
  saving,
  deletePending,
  addDisabled,
  onAdd,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditKind,
  onEditTemporalGrain,
  onRequestDelete,
}: DimensionsCardProps) {
  return (
    <Card className="p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-foreground">
          Dimensions
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <SourceFilterChips
            active={sourceFilter}
            counts={countEntriesBySource(dimensions)}
            onChange={onSourceFilterChange}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={addDisabled}
            onClick={onAdd}
            data-testid="admin-semantic-model-add-dimension-button"
          >
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Add dimension
          </Button>
        </div>
      </header>
      {dimensions.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No dimensions declared.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-left text-muted-foreground">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Column</th>
                <th className="py-3 px-4">Kind</th>
                <th className="py-3 px-4">Exposed</th>
                <th className="py-3 px-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...filterEntriesBySource(dimensions, sourceFilter)]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((d) => (
                  <DimensionRow
                    key={d.name}
                    d={d}
                    saving={saving}
                    deletePending={deletePending}
                    onToggleExposed={(next) => onToggleExposed(d.name, next)}
                    onEditLabel={(next) => onEditLabel(d.name, next)}
                    onEditDescription={(next) =>
                      onEditDescription(d.name, next)
                    }
                    onEditKind={(next) => onEditKind(d.name, next)}
                    onEditTemporalGrain={(next) =>
                      onEditTemporalGrain(d.name, next)
                    }
                    onDelete={() => onRequestDelete(d.name)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
