/**
 * Pure builder for the `DashboardPivotSpec` auto-attached to a dashboard at
 * build time. Extracted from `agentLoop.service.ts::buildAutoPivotSpec` so the
 * value-field guard contract (see pivotDefaultsFromPreview.ts) can be unit-
 * tested without loading the agent runtime / OpenAI client.
 *
 * Uses the same `derivePivotDefaultsFromPreviewRows` that seeds the chat-side
 * pivot panel — so the dashboard's pivot tile renders the SAME view the user
 * sees if they switch the chat response to "Pivot". Returns `undefined` when
 * there's no meaningful row × value pivot to render.
 */
import type { DashboardPivotSpec, DataSummary } from "../shared/schema.js";
import { derivePivotDefaultsFromPreviewRows } from "./pivotDefaultsFromPreview.js";

export function buildAutoPivotSpecFromPreview(args: {
  rows: Record<string, unknown>[];
  columns: string[] | null;
  summary: DataSummary;
  turnId: string;
  sessionId: string | undefined;
}): DashboardPivotSpec | undefined {
  if (args.rows.length === 0) return undefined;

  const defaults = derivePivotDefaultsFromPreviewRows(
    args.rows,
    args.summary,
    args.columns
  );
  if (!defaults) return undefined;
  const pivotRows = defaults.rows ?? [];
  const pivotValues = defaults.values ?? [];
  const pivotColumns = defaults.columns ?? [];
  // After the base-table value-field guard, an empty value list means every
  // candidate measure was a computed alias (e.g. `matching` / `total` /
  // `pjp_adherence_rate`) that doesn't exist on the raw `data` table. Skip the
  // pivot tile rather than persist a config whose SQL would throw a DuckDB
  // binder error at render time.
  if (pivotRows.length === 0 || pivotValues.length === 0) return undefined;

  // Convert plain field names → `{id, field, agg}` shape required by the pivot
  // config schema. Default agg is "sum" (matches the chat-side pivot default).
  const valueSpecs = pivotValues.slice(0, 6).map((field) => ({
    id: `${field}_sum`,
    field,
    agg: "sum" as const,
  }));

  // Title: "<value-fields> by <rows> across <cols>" — terse, mirrors how the
  // chat-side pivot insight describes itself. Capped to 200 chars.
  const valuesPart = pivotValues.slice(0, 3).join(", ");
  const rowsPart = pivotRows.slice(0, 3).join(" × ");
  const colsPart = pivotColumns.slice(0, 2).join(" × ");
  const titleParts: string[] = [valuesPart, `by ${rowsPart}`];
  if (colsPart) titleParts.push(`across ${colsPart}`);
  const title = titleParts.join(" ").slice(0, 200) || "Pivot view";

  return {
    id: `auto-pivot-${args.turnId}`,
    title,
    pivotConfig: {
      rows: pivotRows.slice(0, 4),
      columns: pivotColumns.slice(0, 2),
      values: valueSpecs,
      filters: [],
      unused: [],
    },
    analysisView: "pivot",
    sourceSessionId: args.sessionId,
    createdAt: Date.now(),
  };
}
