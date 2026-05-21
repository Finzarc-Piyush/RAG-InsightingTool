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
 *
 * Wave W61-edit-column · the static `<td>{d.column}</td>` cell is now an
 * `EditableColumnPicker` — a schema-aware dropdown when the detail
 * envelope carries `datasetSchema`, with a free-text `EditableText`
 * fallback when the schema is null (older sessions pre-`dataSummary` or
 * sessions whose `columns[]` array is empty). The picker only offers
 * existing dataset columns so the rebind is by-construction valid; the
 * W58 compiler still owns the authoritative column-binding check at
 * query-plan time.
 */

import { Plus } from "lucide-react";
import type { SemanticDimension } from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  validateColumn,
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

/**
 * W61-edit-column · Schema-aware single-column picker for the dimension's
 * `column` rebind. When `datasetColumns` is non-null, renders a Radix
 * `<Select>` of the dataset's columns (alphabetised) — the admin can
 * only pick a known-existing column, so the rebind is by-construction
 * valid against the live schema. When `datasetColumns` is null (older
 * sessions, or sessions whose `dataSummary.columns` is empty), falls
 * back to `EditableText` so the field is still editable.
 *
 * Always shows the current value as an option, even when it isn't in
 * `datasetColumns` — stale state can happen (dataset re-upload after the
 * model was built, etc.) and the admin should be able to see what the
 * rebind would replace. The orphan value is rendered with a "(not in
 * dataset)" hint so the source-of-drift is visible at a glance.
 *
 * Cap-keyed disable: the picker shares the host's `saving` flag (a
 * single PATCH at a time across all edit cells, matching the
 * EditableText / EditableSelect pattern).
 */
interface EditableColumnPickerProps {
  value: string;
  datasetColumns: ReadonlyArray<string> | null;
  onSave: (next: string) => void;
  disabled: boolean;
  ariaLabel: string;
}

function EditableColumnPicker({
  value,
  datasetColumns,
  onSave,
  disabled,
  ariaLabel,
}: EditableColumnPickerProps) {
  if (datasetColumns === null) {
    return (
      <EditableText
        value={value}
        onSave={onSave}
        validate={validateColumn}
        disabled={disabled}
        ariaLabel={ariaLabel}
        monospace
      />
    );
  }
  const sorted = [...datasetColumns].sort((a, b) => a.localeCompare(b));
  const valueInList = sorted.includes(value);
  return (
    <Select
      value={value}
      onValueChange={onSave}
      disabled={disabled}
    >
      <SelectTrigger
        className="h-8 text-xs font-mono"
        aria-label={ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!valueInList ? (
          <SelectItem
            key={`__orphan__:${value}`}
            value={value}
            className="font-mono text-xs italic text-muted-foreground"
          >
            {value} (not in dataset)
          </SelectItem>
        ) : null}
        {sorted.map((c) => (
          <SelectItem key={c} value={c} className="font-mono text-xs">
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DimensionRow({
  d,
  saving,
  deletePending,
  datasetColumns,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditColumn,
  onEditKind,
  onEditTemporalGrain,
  onDelete,
}: {
  d: SemanticDimension;
  saving: boolean;
  deletePending: boolean;
  datasetColumns: ReadonlyArray<string> | null;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditColumn: (next: string) => void;
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
      <td className="py-3 px-4 min-w-[180px]">
        <EditableColumnPicker
          value={d.column}
          datasetColumns={datasetColumns}
          onSave={onEditColumn}
          disabled={saving}
          ariaLabel={`Edit column for dimension ${d.name}`}
        />
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
  /**
   * W61-edit-column · the session's live dataset column names projected
   * from `data.datasetSchema?.columns.map(c => c.name) ?? null` in the
   * host. `null` when the detail envelope's `datasetSchema` is null (the
   * picker falls back to free-text edit in that case).
   */
  datasetColumns: ReadonlyArray<string> | null;
  sourceFilter: SemanticEntryFilter;
  onSourceFilterChange: (next: SemanticEntryFilter) => void;
  saving: boolean;
  deletePending: boolean;
  addDisabled: boolean;
  onAdd: () => void;
  onToggleExposed: (dimensionName: string, next: boolean) => void;
  onEditLabel: (dimensionName: string, next: string) => void;
  onEditDescription: (dimensionName: string, next: string) => void;
  onEditColumn: (dimensionName: string, next: string) => void;
  onEditKind: (
    dimensionName: string,
    next: SemanticDimension["kind"],
  ) => void;
  onEditTemporalGrain: (dimensionName: string, next: string) => void;
  onRequestDelete: (dimensionName: string) => void;
}

export function DimensionsCard({
  dimensions,
  datasetColumns,
  sourceFilter,
  onSourceFilterChange,
  saving,
  deletePending,
  addDisabled,
  onAdd,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditColumn,
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
                    datasetColumns={datasetColumns}
                    onToggleExposed={(next) => onToggleExposed(d.name, next)}
                    onEditLabel={(next) => onEditLabel(d.name, next)}
                    onEditDescription={(next) =>
                      onEditDescription(d.name, next)
                    }
                    onEditColumn={(next) => onEditColumn(d.name, next)}
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
