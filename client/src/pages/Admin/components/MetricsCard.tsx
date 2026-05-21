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
 */

import { Plus } from "lucide-react";
import type { SemanticMetric } from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
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

function MetricRow({
  m,
  saving,
  deletePending,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditExpression,
  onEditFormat,
  onEditCurrencyCode,
  onDelete,
}: {
  m: SemanticMetric;
  saving: boolean;
  deletePending: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditExpression: (next: string) => void;
  onEditFormat: (next: SemanticMetric["format"]) => void;
  onEditCurrencyCode: (next: string) => void;
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
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {m.references.length === 0 ? "—" : m.references.join(", ")}
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
  sourceFilter: SemanticEntryFilter;
  onSourceFilterChange: (next: SemanticEntryFilter) => void;
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
  onRequestDelete: (metricName: string) => void;
}

export function MetricsCard({
  metrics,
  sourceFilter,
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
