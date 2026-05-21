/**
 * W61-host-extract · `MetricsCard` — the "Metrics" section of the admin
 * semantic-model viewer (`AdminSemanticModelDetail.tsx`). Extracted
 * verbatim so the host can shed ~190 LOC (MetricRow + the card JSX) and
 * relieve the 1,500-LOC sub-component-extract threshold pressure
 * introduced by W61-hierarchy-edit.
 *
 * Self-contained presentational unit: receives the metrics slice + the
 * source filter chip state from the host, surfaces row-level callbacks
 * keyed by the metric's snake_case `name` (host wires those to its
 * `patchMetric` / `handleToggleMetricExposed` / etc. handlers). No
 * server-side coupling; no internal mutation; safe to test in isolation
 * once a Playwright / RTL smoke wave lands.
 *
 * Why one Card + private Row pair per file (rather than two siblings):
 * the row is consumed nowhere else, and the props surface is wide
 * enough that exporting it would multiply the test surface for zero
 * upside. Pattern mirrors `AuditHistoryCard.tsx` (single card + its
 * internal row layout).
 *
 * Wave W61-edit-references · the read-only "References" cell now hosts
 * an `EditableColumnTagList` — admins add columns from a dropdown of
 * dataset columns (when `datasetSchema` is non-null) or via a free-text
 * input (fallback). Each tag is removable. Drives the W58 compiler's
 * orphan-column lint via `validateModel` (W63).
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { SemanticMetric } from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  REFERENCES_MAX,
  validateColumn,
  validateCurrencyCode,
  validateDescription,
  validateExpression,
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

/**
 * W61-edit-enums · enum option picker for the metric format cell.
 * Values must stay byte-exact to the zod enum in
 * [`semanticMetricSchema`](../../../../server/shared/schema.ts);
 * the server's `safeParse` is the authoritative source and a typo
 * here would round-trip to a 400 with the invalid-enum issue
 * surfacing in the existing "Save failed" banner.
 */
const METRIC_FORMAT_OPTIONS = [
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "currency", label: "Currency" },
  { value: "ratio", label: "Ratio" },
  { value: "duration", label: "Duration" },
] as const satisfies ReadonlyArray<{
  value: SemanticMetric["format"];
  label: string;
}>;

/**
 * W61-edit-references · Schema-aware tag-list for the metric's
 * `references` column array. Renders existing entries as removable
 * chips; admins add new entries via a dropdown of remaining dataset
 * columns (when `datasetColumns` is non-null) or a free-text input
 * (fallback when the schema is null).
 *
 * UI rules:
 *   - Existing tags shown alphabetically (matches the picker ordering)
 *   - "+ Add column…" affordance hidden when at the `REFERENCES_MAX`
 *     cap (20) — instead, a "Max N references" footer message is shown
 *   - Dropdown options exclude already-referenced columns so the same
 *     column can't be added twice
 *   - Free-text add path validates via `validateColumn` and dedupes
 *   - Whole-array replacement via `onSave([...current, newCol])` or
 *     `onSave(current.filter(c => c !== removedCol))` — the host's
 *     `patchMetric` re-runs the optimistic-update + PATCH flow for
 *     each tag mutation (one save per add/remove). Batching multiple
 *     tag changes into a single save would need a draft buffer, which
 *     would mismatch the inline-edit semantics of the other cells.
 *
 * The W58 compiler does the authoritative column-binding check; this
 * UI only narrows the set of values the admin can choose from to keep
 * the round-trip path obviously-valid.
 */
interface EditableColumnTagListProps {
  values: ReadonlyArray<string>;
  datasetColumns: ReadonlyArray<string> | null;
  onSave: (next: string[]) => void;
  disabled: boolean;
  ariaLabel: string;
}

function EditableColumnTagList({
  values,
  datasetColumns,
  onSave,
  disabled,
  ariaLabel,
}: EditableColumnTagListProps) {
  const [pendingAdd, setPendingAdd] = useState<string>("");
  const [addError, setAddError] = useState<string | null>(null);

  const atMax = values.length >= REFERENCES_MAX;

  function handleRemove(col: string): void {
    onSave(values.filter((v) => v !== col));
  }

  function handleAddFromSelect(col: string): void {
    if (values.includes(col)) return;
    if (atMax) return;
    onSave([...values, col]);
  }

  function handleAddFromInput(): void {
    const trimmed = pendingAdd.trim();
    const err = validateColumn(trimmed);
    if (err) {
      setAddError(err);
      return;
    }
    if (values.includes(trimmed)) {
      setAddError("Already in references");
      return;
    }
    onSave([...values, trimmed]);
    setPendingAdd("");
    setAddError(null);
  }

  const remainingCols = datasetColumns
    ? datasetColumns
        .filter((c) => !values.includes(c))
        .sort((a, b) => a.localeCompare(b))
    : [];
  const sortedValues = [...values].sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-2" aria-label={ariaLabel}>
      {sortedValues.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {sortedValues.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[11px] font-mono"
            >
              {c}
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => handleRemove(c)}
                  aria-label={`Remove ${c} from references`}
                  className="text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40 rounded"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}

      {!atMax && datasetColumns !== null && remainingCols.length > 0 ? (
        <Select
          value=""
          onValueChange={handleAddFromSelect}
          disabled={disabled}
        >
          <SelectTrigger
            className="h-7 text-xs"
            aria-label={`Add column reference for ${ariaLabel}`}
          >
            <SelectValue placeholder="+ Add column…" />
          </SelectTrigger>
          <SelectContent>
            {remainingCols.map((c) => (
              <SelectItem key={c} value={c} className="font-mono text-xs">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {!atMax && datasetColumns === null ? (
        <div className="space-y-1">
          <div className="flex gap-1">
            <Input
              value={pendingAdd}
              onChange={(e) => {
                setPendingAdd(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddFromInput();
                }
              }}
              disabled={disabled}
              placeholder="Column name…"
              className="h-7 font-mono text-xs"
              aria-label={`New column reference for ${ariaLabel}`}
              aria-invalid={addError ? true : undefined}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAddFromInput}
              disabled={disabled || pendingAdd.trim().length === 0}
              className="h-7 px-2 text-xs"
            >
              Add
            </Button>
          </div>
          {addError ? (
            <p className="text-xs text-destructive" role="alert">
              {addError}
            </p>
          ) : null}
        </div>
      ) : null}

      {atMax ? (
        <p className="text-[11px] text-muted-foreground">
          Max {REFERENCES_MAX} references.
        </p>
      ) : null}
    </div>
  );
}

function MetricRow({
  m,
  saving,
  deletePending,
  datasetColumns,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditExpression,
  onEditFormat,
  onEditCurrencyCode,
  onEditReferences,
  onDelete,
}: {
  m: SemanticMetric;
  saving: boolean;
  deletePending: boolean;
  datasetColumns: ReadonlyArray<string> | null;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditExpression: (next: string) => void;
  onEditFormat: (next: SemanticMetric["format"]) => void;
  onEditCurrencyCode: (next: string) => void;
  onEditReferences: (next: string[]) => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-foreground">{m.name}</div>
          <SourceBadge source={m.source} />
        </div>
        <EditableText
          value={m.label}
          onSave={onEditLabel}
          validate={validateLabel}
          disabled={saving}
          ariaLabel={`Edit label for metric ${m.name}`}
        />
        <EditableText
          value={m.description ?? ""}
          onSave={onEditDescription}
          validate={validateDescription}
          disabled={saving}
          ariaLabel={`Edit description for metric ${m.name}`}
          multiline
          placeholder="Description (shown to the planner)…"
        />
      </td>
      <td className="py-3 px-4 min-w-[220px]">
        <EditableText
          value={m.expression}
          onSave={onEditExpression}
          validate={validateExpression}
          disabled={saving}
          ariaLabel={`Edit expression for metric ${m.name}`}
          monospace
        />
      </td>
      <td className="py-3 px-4 min-w-[160px] space-y-2">
        <EditableSelect
          value={m.format}
          options={METRIC_FORMAT_OPTIONS}
          onSave={onEditFormat}
          disabled={saving}
          ariaLabel={`Edit format for metric ${m.name}`}
        />
        {m.format === "currency" ? (
          <EditableText
            value={m.currencyCode ?? ""}
            onSave={onEditCurrencyCode}
            validate={validateCurrencyCode}
            disabled={saving}
            ariaLabel={`Edit currency code for metric ${m.name}`}
            monospace
            placeholder="USD / INR / EUR"
          />
        ) : null}
        {m.decimals !== undefined ? (
          <div className="text-xs text-muted-foreground">
            {m.decimals} dp
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4 min-w-[180px]">
        <EditableColumnTagList
          values={m.references}
          datasetColumns={datasetColumns}
          onSave={onEditReferences}
          disabled={saving}
          ariaLabel={`metric ${m.name}`}
        />
      </td>
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={m.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${m.label} exposed`}
        />
      </td>
      <td className="py-3 px-4">
        <RowDeleteButton
          onDelete={onDelete}
          disabled={saving || deletePending}
          ariaLabel={`Delete metric ${m.name}`}
        />
      </td>
    </tr>
  );
}

export interface MetricsCardProps {
  metrics: SemanticMetric[];
  /**
   * W61-edit-references · the session's live dataset column names
   * projected from `data.datasetSchema?.columns.map(c => c.name) ?? null`
   * in the host. `null` when the detail envelope's `datasetSchema` is
   * null — the tag list falls back to a free-text input in that case so
   * the field is still editable.
   */
  datasetColumns: ReadonlyArray<string> | null;
  sourceFilter: SemanticEntryFilter;
  /**
   * W61-per-section-filter · true when the Metrics card currently has
   * a per-section override (i.e. its effective filter is not inherited
   * from the host's global filter). Surfaces an "(overridden)" hint
   * next to the chip row so the override state is discoverable.
   */
  isSectionOverridden?: boolean;
  /**
   * W61-per-section-filter · `modifier=true` is shift-click (per-
   * section override path); `modifier=false` is plain-click (global
   * re-sync path). Host routes via `applyChipClick`.
   */
  onSourceFilterChange: (next: SemanticEntryFilter, modifier: boolean) => void;
  saving: boolean;
  deletePending: boolean;
  addDisabled: boolean;
  onAdd: () => void;
  onToggleExposed: (metricName: string, next: boolean) => void;
  onEditLabel: (metricName: string, next: string) => void;
  onEditDescription: (metricName: string, next: string) => void;
  onEditExpression: (metricName: string, next: string) => void;
  onEditFormat: (metricName: string, next: SemanticMetric["format"]) => void;
  onEditCurrencyCode: (metricName: string, next: string) => void;
  onEditReferences: (metricName: string, next: string[]) => void;
  onRequestDelete: (metricName: string) => void;
}

export function MetricsCard({
  metrics,
  datasetColumns,
  sourceFilter,
  isSectionOverridden,
  onSourceFilterChange,
  saving,
  deletePending,
  addDisabled,
  onAdd,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditExpression,
  onEditFormat,
  onEditCurrencyCode,
  onEditReferences,
  onRequestDelete,
}: MetricsCardProps) {
  return (
    <Card className="p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-foreground">
          Metrics
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <SourceFilterChips
            active={sourceFilter}
            counts={countEntriesBySource(metrics)}
            onChange={onSourceFilterChange}
            isOverridden={isSectionOverridden}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={addDisabled}
            onClick={onAdd}
            data-testid="admin-semantic-model-add-metric-button"
          >
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Add metric
          </Button>
        </div>
      </header>
      {metrics.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No metrics declared.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-left text-muted-foreground">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Expression</th>
                <th className="py-3 px-4">Format</th>
                <th className="py-3 px-4">References</th>
                <th className="py-3 px-4">Exposed</th>
                <th className="py-3 px-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...filterEntriesBySource(metrics, sourceFilter)]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((m) => (
                  <MetricRow
                    key={m.name}
                    m={m}
                    saving={saving}
                    deletePending={deletePending}
                    datasetColumns={datasetColumns}
                    onToggleExposed={(next) => onToggleExposed(m.name, next)}
                    onEditLabel={(next) => onEditLabel(m.name, next)}
                    onEditDescription={(next) =>
                      onEditDescription(m.name, next)
                    }
                    onEditExpression={(next) =>
                      onEditExpression(m.name, next)
                    }
                    onEditFormat={(next) => onEditFormat(m.name, next)}
                    onEditCurrencyCode={(next) =>
                      onEditCurrencyCode(m.name, next)
                    }
                    onEditReferences={(next) =>
                      onEditReferences(m.name, next)
                    }
                    onDelete={() => onRequestDelete(m.name)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
