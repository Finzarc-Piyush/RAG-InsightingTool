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
import { suggestPivotColumnsFromDimensions } from "./pivotLayoutFromDimensions.js";

export type PivotDefaultsRowsValues = {
  rows: string[];
  values: string[];
  columns?: string[];
  filterFields?: string[];
  filterSelections?: Record<string, string[]>;
  /**
   * The agent's last `execute_query_plan` had no `groupBy` and the result is a
   * single-row aggregate (a scalar). Callers must NOT fabricate row dimensions
   * from schema heuristics in this case — render no pivot/chart.
   */
  scalar?: boolean;
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

  let rowOut = traceRowsMatchOutput
    ? traceRows
    : fromPreview?.rows?.length
      ? fromPreview.rows
      : traceRows;

  let columnsOut: string[] =
    !traceRowsMatchOutput && fromPreview?.columns?.length
      ? [...fromPreview.columns]
      : [];

  const needsTraceOrFallbackLayout =
    traceRowsMatchOutput ||
    (!fromPreview?.rows?.length && rowOut.length > 0);

  if (needsTraceOrFallbackLayout) {
    const laid = suggestPivotColumnsFromDimensions({
      rowCandidates: traceRowsMatchOutput ? traceRows : rowOut,
      dataSummary,
      pivotColumnDimensions: undefined,
    });
    rowOut = laid.rows;
    columnsOut = [...laid.columns];
  }

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
    rowOut,
    columnsOut
  );

  const out: PivotDefaultsRowsValues = {
    rows: rowOut,
    values: valueOut,
  };
  if (columnsOut.length) {
    out.columns = columnsOut;
  }
  if (slice.filterFields.length) {
    out.filterFields = slice.filterFields;
  }
  if (Object.keys(slice.filterSelections).length) {
    out.filterSelections = slice.filterSelections;
  }

  // WPF7 · For compound-shape wide-format-melted datasets, pre-select a
  // single Metric value in the pivot filter so the default render doesn't
  // silently SUM across mixed metrics (value_sales + volume = garbage).
  // Only when Metric isn't already pinned to rows / columns / filters by
  // the trace plan or the dimension-filter slice.
  const wf = dataSummary.wideFormatTransform;
  if (
    wf?.detected &&
    wf.shape === "compound" &&
    wf.metricColumn &&
    !out.rows.includes(wf.metricColumn) &&
    !(out.columns ?? []).includes(wf.metricColumn) &&
    !(out.filterFields ?? []).includes(wf.metricColumn)
  ) {
    const metricCol = dataSummary.columns.find(
      (c) => c.name === wf.metricColumn
    );
    const distinctMetrics = (metricCol?.topValues ?? [])
      .map((t) => String(t.value).trim())
      .filter(Boolean);
    if (distinctMetrics.length > 0) {
      const preferred =
        distinctMetrics.find((m) =>
          /value[\s_-]*sales|sales[\s_-]*value|revenue|^sales$/i.test(m)
        ) ?? distinctMetrics[0];
      out.filterFields = [...(out.filterFields ?? []), wf.metricColumn];
      out.filterSelections = {
        ...(out.filterSelections ?? {}),
        [wf.metricColumn]: [preferred],
      };
    }
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

  // Scalar: an analytical step produced a single-row aggregate with no row
  // dimensions. Two shapes hit this — (a) execute_query_plan with empty groupBy,
  // (b) run_analytical_query whose parsed plan didn't surface as a trace step.
  // Suppress the pivot/chart so callers don't fabricate dimensions from schema
  // heuristics.
  if (tableRows.length <= 1) {
    if (tracePlan) {
      const scalarHints = collectTraceHintsFromPlan(tracePlan, dataSummary);
      if (scalarHints.traceRows.length === 0) {
        return { rows: [], values: [], scalar: true };
      }
    } else {
      const fromPreviewScalar = derivePivotDefaultsFromPreviewRows(
        tableRows,
        dataSummary,
        tableColumns.length ? tableColumns : null
      );
      if (
        fromPreviewScalar &&
        (!fromPreviewScalar.rows || fromPreviewScalar.rows.length === 0)
      ) {
        return { rows: [], values: [], scalar: true };
      }
    }
  }

  if (!tracePlan) {
    const fromPreview = derivePivotDefaultsFromPreviewRows(
      tableRows,
      dataSummary,
      tableColumns.length ? tableColumns : null
    );
    if (!fromPreview?.rows?.length && !fromPreview?.values?.length) return undefined;
    const out: PivotDefaultsRowsValues = {
      rows: fromPreview.rows ?? [],
      values: fromPreview.values ?? [],
    };
    if (fromPreview.columns?.length) {
      out.columns = [...fromPreview.columns];
    }
    return out;
  }

  return mergePivotDefaultRowsAndValues({
    dataSummary,
    tracePlan,
    tableRows,
    tableColumns,
  });
}
