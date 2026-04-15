/**
 * Pivot default rows/values from the last execute_query_plan agent step + preview table.
 * Normalizes legacy temporal facet ids in the trace plan and only uses trace row hints
 * when every hint appears on actual result columns (avoids Order Date vs Month · Order Date skew).
 */

import type { DimensionFilter } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "./queryPlanExecutor.js";
import {
  allowedColumnNamesForQueryPlan,
  normalizeLegacyTemporalFacetKeysInPlan,
} from "./queryPlanExecutor.js";
import {
  derivePivotDefaultsFromPreviewRows,
  normalizePivotValueFieldForBaseTable,
} from "./pivotDefaultsFromPreview.js";
import { pivotSliceDefaultsFromDimensionFilters } from "./pivotSliceDefaultsFromDimensionFilters.js";

export type PivotDefaultsRowsValues = {
  rows: string[];
  values: string[];
  filterFields?: string[];
  filterSelections?: Record<string, string[]>;
};

function collectTraceHintsFromPlan(
  plan: QueryPlanBody,
  dataSummary: DataSummary
): { traceRows: string[]; traceValues: string[] } {
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns || []);
  const rows: string[] = [];
  const values: string[] = [];
  const seenRows = new Set<string>();
  const seenValues = new Set<string>();

  const addRow = (col: string) => {
    if (!allowed.has(col) || numeric.has(col) || seenRows.has(col)) return;
    seenRows.add(col);
    rows.push(col);
  };
  const addValue = (col: string) => {
    if (!allowed.has(col) || !numeric.has(col) || seenValues.has(col)) return;
    seenValues.add(col);
    values.push(col);
  };

  const normalized = normalizeLegacyTemporalFacetKeysInPlan(plan, dataSummary);

  for (const col of normalized.groupBy ?? []) addRow(col);
  for (const agg of normalized.aggregations ?? []) {
    if (typeof agg?.column === "string") addValue(agg.column);
  }
  return { traceRows: rows, traceValues: values };
}

function previewOutputKeySet(
  tableColumns: string[],
  tableRows: Record<string, unknown>[]
): Set<string> {
  const keys = new Set<string>();
  if (tableColumns.length) {
    for (const c of tableColumns) keys.add(c);
  } else if (tableRows[0] && typeof tableRows[0] === "object") {
    for (const k of Object.keys(tableRows[0])) keys.add(k);
  }
  return keys;
}

/**
 * Exported for unit tests: merge logic given a single normalized trace plan shape.
 */
export function mergePivotDefaultRowsAndValues(params: {
  dataSummary: DataSummary;
  tracePlan: QueryPlanBody;
  tableRows: Record<string, unknown>[];
  tableColumns: string[];
}): PivotDefaultsRowsValues | undefined {
  const { dataSummary, tracePlan, tableRows, tableColumns } = params;

  const { traceRows, traceValues } = collectTraceHintsFromPlan(
    tracePlan,
    dataSummary
  );

  const fromPreview = derivePivotDefaultsFromPreviewRows(
    tableRows,
    dataSummary,
    tableColumns.length ? tableColumns : null
  );

  const previewKeys = previewOutputKeySet(tableColumns, tableRows);
  const traceRowsMatchOutput =
    traceRows.length > 0 && traceRows.every((r) => previewKeys.has(r));

  const rowOut = traceRowsMatchOutput
    ? traceRows
    : fromPreview?.rows?.length
      ? fromPreview.rows
      : traceRows;

  const rawValues = traceValues.length
    ? traceValues
    : (fromPreview?.values ?? []);

  const seenNorm = new Set<string>();
  const valueOut: string[] = [];
  for (const v of rawValues) {
    const n = normalizePivotValueFieldForBaseTable(v, dataSummary);
    if (seenNorm.has(n)) continue;
    seenNorm.add(n);
    valueOut.push(n);
  }

  if (rowOut.length === 0 && valueOut.length === 0) return undefined;

  const normalizedPlan = normalizeLegacyTemporalFacetKeysInPlan(
    tracePlan,
    dataSummary
  );
  const slice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    normalizedPlan.dimensionFilters as DimensionFilter[] | undefined,
    rowOut
  );

  const out: PivotDefaultsRowsValues = {
    rows: rowOut,
    values: valueOut,
  };
  if (slice.filterFields.length) {
    out.filterFields = slice.filterFields;
  }
  if (Object.keys(slice.filterSelections).length) {
    out.filterSelections = slice.filterSelections;
  }
  return out;
}

export function derivePivotDefaultsFromExecutionMerged(
  dataSummary: DataSummary,
  agentTrace: Record<string, unknown> | undefined,
  table: unknown
): PivotDefaultsRowsValues | undefined {
  const steps = Array.isArray(agentTrace?.steps)
    ? (agentTrace!.steps as Array<Record<string, unknown>>)
    : [];

  let tracePlan: QueryPlanBody | undefined;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step?.tool !== "execute_query_plan") continue;
    const raw = (step?.args as Record<string, unknown> | undefined)?.plan;
    if (!raw || typeof raw !== "object") continue;
    const plan = raw as QueryPlanBody;
    const hints = collectTraceHintsFromPlan(plan, dataSummary);
    const hasDimensionFilters =
      Array.isArray(plan.dimensionFilters) && plan.dimensionFilters.length > 0;
    if (
      hints.traceRows.length > 0 ||
      hints.traceValues.length > 0 ||
      hasDimensionFilters
    ) {
      tracePlan = plan;
      break;
    }
  }

  const tableColumns: string[] = Array.isArray((table as { columns?: unknown })?.columns)
    ? ((table as { columns: unknown[] }).columns as unknown[]).filter(
        (v): v is string => typeof v === "string"
      )
    : [];
  const tableRows: Record<string, unknown>[] = Array.isArray(
    (table as { rows?: unknown })?.rows
  )
    ? ((table as { rows: unknown[] }).rows as Record<string, unknown>[])
    : [];

  if (!tracePlan) {
    const fromPreview = derivePivotDefaultsFromPreviewRows(
      tableRows,
      dataSummary,
      tableColumns.length ? tableColumns : null
    );
    if (!fromPreview?.rows?.length && !fromPreview?.values?.length) return undefined;
    return {
      rows: fromPreview.rows ?? [],
      values: fromPreview.values ?? [],
    };
  }

  return mergePivotDefaultRowsAndValues({
    dataSummary,
    tracePlan,
    tableRows,
    tableColumns,
  });
}
