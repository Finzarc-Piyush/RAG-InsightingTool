/**
 * Pivot default rows/values from the last execute_query_plan agent step + preview table.
 * Normalizes legacy temporal facet ids in the trace plan and only uses trace row hints
 * when every hint appears on actual result columns (avoids Order Date vs Month · Order Date skew).
 */

import type { DimensionFilter } from "../shared/queryTypes.js";
import type { DataSummary, PivotAggLiteral } from "../shared/schema.js";
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

/**
 * PVT5 · the unified safety contract. A pivot defaults object is "safe to
 * ship" iff:
 *   - rows.length + (columns?.length ?? 0) ≤ MAX_AXIS_FIELDS  (no axis-stuffing)
 *   - values.length ≤ MAX_VALUE_FIELDS                        (no measure-stuffing)
 *
 * The user's invariant: "if a pivot is being generated, under no circumstance
 * should all fields get used". When this contract fails (e.g. the row-level
 * categorizer dumped every dimension into ROWS), the caller must SUPPRESS the
 * pivot entirely. The chat surface then emits `pivotUnavailable: true` and
 * the client renders an elegant fallback explaining the answer is correct
 * but the pivot couldn't be generated.
 *
 * Limits are tuned for the natural shapes the agent produces: groupBy 1-3,
 * aggregations 1-3. A 4+4 ceiling is liberal enough for cross-tab pivots
 * (rows + columns) and concrete enough to catch the every-column explosion.
 */
export const PIVOT_DEFAULTS_MAX_AXIS_FIELDS = 4;
export const PIVOT_DEFAULTS_MAX_VALUE_FIELDS = 4;

export function isPivotDefaultsShapeSafe(
  defaults: { rows?: string[]; columns?: string[]; values?: string[] } | null | undefined
): boolean {
  if (!defaults) return false;
  const rowsLen = defaults.rows?.length ?? 0;
  const colsLen = defaults.columns?.length ?? 0;
  const valuesLen = defaults.values?.length ?? 0;
  if (rowsLen + colsLen > PIVOT_DEFAULTS_MAX_AXIS_FIELDS) return false;
  if (valuesLen > PIVOT_DEFAULTS_MAX_VALUE_FIELDS) return false;
  return true;
}

export type PivotDefaultsRowsValues = {
  rows: string[];
  values: string[];
  columns?: string[];
  filterFields?: string[];
  filterSelections?: Record<string, string[]>;
  /**
   * Wave PAG1 · Per-value aggregator hints derived from the agent's
   * `execute_query_plan.aggregations[]`. Maps source column name (matches
   * entries in `values`) to a `PivotAgg` literal — `mean | avg → "mean"`,
   * `sum | sumIf → "sum"`, `count | countIf → "count"`, `min → "min"`,
   * `max → "max"`. `median` / `percent_change` are omitted so the client
   * falls back to its numeric-default. Present only when at least one
   * mapping was derived; absent for filter-projection plans (PVT1).
   */
  valueAggregators?: Record<string, PivotAggLiteral>;
  /**
   * The agent's last `execute_query_plan` had no `groupBy` and the result is a
   * single-row aggregate (a scalar). Callers must NOT fabricate row dimensions
   * from schema heuristics in this case — render no pivot/chart.
   */
  scalar?: boolean;
};

/**
 * Wave PAG1 · Map the agent's `aggregations[].operation` enum to the
 * client-side `PivotAgg` literal. The agent enum is richer than the client
 * supports — `median` and `percent_change` have no PivotAgg equivalent, so
 * those plans return `undefined` and the client falls back to its numeric
 * default. Conditional aggregations (`countIf` / `sumIf`) collapse to their
 * non-conditional cousins because the predicate has already been applied
 * by the executor before the pivot ever runs.
 */
export function mapOperationToPivotAgg(
  operation: string | undefined | null
): PivotAggLiteral | undefined {
  if (typeof operation !== "string") return undefined;
  switch (operation.trim().toLowerCase()) {
    case "sum":
    case "sumif":
      return "sum";
    case "mean":
    case "avg":
      return "mean";
    case "count":
    case "countif":
      return "count";
    case "min":
      return "min";
    case "max":
      return "max";
    case "median":
    case "percent_change":
    default:
      return undefined;
  }
}

/**
 * Tools that transform the canonical row-level frame (add a column, bucket a
 * dimension) but do NOT produce an analytical aggregate. Their `table.rows`
 * is the per-row dataset, so feeding it into `derivePivotDefaultsFromPreviewRows`
 * would categorize every dimension as a pivot row and produce a catastrophic
 * "every column on ROWS" cascade. When the trace lacks any analytical step,
 * we suppress the pivot rather than fabricate one from row-level data.
 */
const DATA_PREP_TOOLS = new Set<string>([
  "add_computed_columns",
  "derive_dimension_bucket",
]);

const ANALYTICAL_TABLE_TOOLS = new Set<string>([
  "execute_query_plan",
  "run_analytical_query",
  "run_readonly_sql",
  "run_segment_driver_analysis",
  "breakdown_ranking",
  "two_segment_compare",
  "run_correlation",
]);

function collectTraceHintsFromPlan(
  plan: QueryPlanBody,
  dataSummary: DataSummary
): {
  traceRows: string[];
  traceValues: string[];
  /**
   * Wave QL9.A · Output-column names the executor will return that DON'T
   * exist in the source dataSummary — aggregation aliases + Wave QL7
   * `computedAggregations` aliases. Source-column-name values still flow
   * through `traceValues`; the scalar branch and result-shape callers
   * union the two so the pivot sees the ACTUAL columns of the result
   * table (e.g. `total_compliance_visit`, `num_distinct_date`,
   * `avg_compliance_visit_per_date`) instead of falling back to the raw
   * dataset preview.
   */
  traceAliasValues: string[];
} {
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns || []);
  const rows: string[] = [];
  const values: string[] = [];
  const aliasValues: string[] = [];
  const seenRows = new Set<string>();
  const seenValues = new Set<string>();
  const seenAliases = new Set<string>();

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
  const addAliasValue = (alias: string) => {
    const trimmed = alias.trim();
    if (!trimmed || seenAliases.has(trimmed)) return;
    seenAliases.add(trimmed);
    aliasValues.push(trimmed);
  };

  const normalized = normalizeLegacyTemporalFacetKeysInPlan(plan, dataSummary);

  for (const col of normalized.groupBy ?? []) addRow(col);
  for (const agg of normalized.aggregations ?? []) {
    if (typeof agg?.column === "string") addValue(agg.column);
    // Wave QL9.A · Output alias names are the column names users actually
    // see in the result table; they need to reach the pivot's values shelf
    // even though they aren't in `dataSummary.numericColumns`.
    if (typeof agg?.alias === "string") addAliasValue(agg.alias);
  }
  // Wave QL9.A · `computedAggregations` are output-only columns produced by
  // the wrapping SELECT (e.g. `total / num_days AS avg_per_day`). They have
  // no source-column counterpart — alias is the only handle.
  const computedAggs = (normalized as QueryPlanBody).computedAggregations;
  if (Array.isArray(computedAggs)) {
    for (const c of computedAggs) {
      if (typeof c?.alias === "string") addAliasValue(c.alias);
    }
  }
  return { traceRows: rows, traceValues: values, traceAliasValues: aliasValues };
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

  const { traceRows, traceValues, traceAliasValues } = collectTraceHintsFromPlan(
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

  // PVT1 · Filter-projection guard: when the trace plan has groupBy dimensions
  // but no `aggregations` (e.g. "list TSOEs where PJP Adherence = No PJP
  // Available"), the executor returns the full filtered row-level slice. Do
  // NOT fall back to `fromPreview.values` here — that would dump every numeric
  // column from the slice into VALUES. Empty `values` is honest: the user
  // sees their dimensions listed, with the dimension filter as a chip, and
  // can drag a measure if they want one.
  const normalizedForAggCheck = normalizeLegacyTemporalFacetKeysInPlan(
    tracePlan,
    dataSummary
  );
  const isFilterProjection =
    traceValues.length === 0 &&
    rowOut.length > 0 &&
    !(
      Array.isArray(normalizedForAggCheck.aggregations) &&
      normalizedForAggCheck.aggregations.length > 0
    );

  // PVT6 · redundant-filter detector. When every groupBy column is also
  // pinned to a SINGLE value via an `in` dimensionFilter, the groupBy is
  // semantically redundant — the result is a row-level slice for one
  // specific entity ("Investigate operational practices in Cluster 1
  // NORTH"). A pivot with rows=[that-column] would render exactly one row
  // with one cell — useless. Suppress so the chat-stream cascade (PVT5)
  // emits `pivotUnavailable: true` and the elegant fallback renders.
  if (isFilterProjection) {
    const groupByCols = (normalizedForAggCheck.groupBy ?? []).map(String);
    const filtersByCol = new Map<string, string[]>();
    for (const f of (normalizedForAggCheck.dimensionFilters ?? []) as DimensionFilter[]) {
      if (!f || f.op !== "in") continue;
      if (typeof f.column !== "string") continue;
      if (!Array.isArray(f.values) || f.values.length === 0) continue;
      filtersByCol.set(f.column, f.values.map(String));
    }
    const everyGroupByPinnedToSingle =
      groupByCols.length > 0 &&
      groupByCols.every((col) => {
        const vals = filtersByCol.get(col);
        return Array.isArray(vals) && vals.length === 1;
      });
    if (everyGroupByPinnedToSingle) return undefined;
  }

  // Wave QL9.A · Union the source-column values with the alias values from
  // `aggregations[].alias` + `computedAggregations[].alias`. Aliases that
  // actually appear in the output (previewKeys) are the OUTPUT columns the
  // user sees and the ones the pivot should offer as VALUES. For the
  // QL7 ratio shape, this surfaces `total_compliance_visit`,
  // `num_distinct_date`, and `avg_compliance_visit_per_date`; without it,
  // only source columns (which often get filtered out — Date is a date
  // column, Compliance Visit may be aliased away) reached values.
  const aliasValuesInOutput = traceAliasValues.filter((alias) =>
    previewKeys.has(alias)
  );
  const rawValues = (() => {
    if (traceValues.length || aliasValuesInOutput.length) {
      const seen = new Set<string>();
      const combined: string[] = [];
      for (const v of traceValues) {
        if (!seen.has(v)) {
          seen.add(v);
          combined.push(v);
        }
      }
      for (const v of aliasValuesInOutput) {
        if (!seen.has(v)) {
          seen.add(v);
          combined.push(v);
        }
      }
      return combined;
    }
    if (isFilterProjection) return [];
    return fromPreview?.values ?? [];
  })();

  // PVT2 · Aggregation aliases (e.g. `Average_Compliance_Visits` from an
  // `aggregations[].alias`) appear as columns in the result table but do NOT
  // exist on the base `data` table. The pivot SQL builder (pivotQueryService)
  // SELECTs value fields as raw column literals, so shipping an alias here
  // produces a DuckDB binder error ("Referenced column ... not found in
  // FROM clause"). Build an alias→source map from the trace plan and
  // substitute alias hits with their source column.
  //
  // Wave PAG1 · Same loop, also build `sourceToAgg` (source column →
  // PivotAgg) so the pivot value chip can be pre-set to the agent's actual
  // aggregation function instead of defaulting to Sum. Last-write-wins on
  // duplicate columns matches the existing `values` array dedupe semantics.
  const aliasToSource = new Map<string, string>();
  const sourceToAgg = new Map<string, PivotAggLiteral>();
  for (const agg of normalizedForAggCheck.aggregations ?? []) {
    if (!agg || typeof agg !== "object") continue;
    const src = typeof agg.column === "string" ? agg.column.trim() : "";
    const operation = typeof agg.operation === "string" ? agg.operation : "";
    if (!src) continue;
    const explicitAlias =
      typeof (agg as { alias?: string }).alias === "string"
        ? (agg as { alias: string }).alias.trim()
        : "";
    if (explicitAlias) aliasToSource.set(explicitAlias, src);
    // Mirror the executor's auto-alias shape `${column}_${operation}` so
    // result-table columns like `Sales_sum` are also mapped back.
    if (operation) aliasToSource.set(`${src}_${operation}`, src);
    // PD1 · also mirror the nested-aggregation auto-alias shape
    // `${column}_${operation}_per_${safePerDim}` (matches the executor's
    // `outputAliasForAgg` when `perDimension` is set).
    const perDim =
      typeof (agg as { perDimension?: string }).perDimension === "string"
        ? (agg as { perDimension: string }).perDimension
        : "";
    if (operation && perDim) {
      const safePerDim = perDim
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
      aliasToSource.set(`${src}_${operation}_per_${safePerDim}`, src);
    }
    const mappedAgg = mapOperationToPivotAgg(operation);
    if (mappedAgg) sourceToAgg.set(src, mappedAgg);
  }

  // PD1 · pre-populate `columns` with the per-dimension when the plan is
  // nested and no other columns hint was derived. Gives the user the
  // per-day cross-tab when they switch to pivot view. Cap at 60-cardinality
  // proxy by skipping when the perDim already has > 60 distinct topValues
  // — the pivot cross-tab can't render 1000 columns usefully.
  const nestedPerDims = new Set<string>();
  for (const agg of normalizedForAggCheck.aggregations ?? []) {
    const pd = (agg as { perDimension?: string })?.perDimension;
    if (typeof pd === "string" && pd.length > 0) nestedPerDims.add(pd);
  }
  if (
    nestedPerDims.size === 1 &&
    columnsOut.length === 0 &&
    rowOut.length > 0
  ) {
    const perDim = [...nestedPerDims][0]!;
    if (!rowOut.includes(perDim)) {
      const perDimMeta = dataSummary.columns.find((c) => c.name === perDim);
      const distinctCount =
        (perDimMeta as { uniqueCount?: number } | undefined)?.uniqueCount ??
        (perDimMeta?.topValues?.length ?? 0);
      // 60-cell cap on the column axis. Below this is fine for a cross-tab.
      // Above, skip — the user can still drag the field manually.
      if (distinctCount === 0 || distinctCount <= 60) {
        columnsOut = [perDim];
      }
    }
  }
  const numericSchema = new Set(dataSummary.numericColumns ?? []);
  const seenNorm = new Set<string>();
  const valueOut: string[] = [];
  for (const v of rawValues) {
    const aliasMapped = aliasToSource.get(v) ?? v;
    const n = normalizePivotValueFieldForBaseTable(aliasMapped, dataSummary);
    // PVT2 · strict guard — pivot value fields MUST be real columns on the
    // base `data` table. If an alias couldn't be mapped back to a numeric
    // schema column, drop it. The pivot then renders rows-only (filter-
    // projection style) rather than failing with a binder error. Encodes
    // the user's rule: never ship a pivot config we can't actually execute.
    if (!numericSchema.has(n)) continue;
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

  // Wave PAG1 · Stamp the agent's per-column aggregation function on the
  // value fields that survived alias mapping + numeric-schema validation.
  // Only emit the field when at least one mapping landed — keeps the
  // envelope minimal on filter-projection plans (no aggregations → empty
  // map → field omitted) and on plans whose only ops are `median`/
  // `percent_change` (unmapped → empty map → field omitted).
  if (valueOut.length > 0 && sourceToAgg.size > 0) {
    const aggregators: Record<string, PivotAggLiteral> = {};
    for (const v of valueOut) {
      const a = sourceToAgg.get(v);
      if (a) aggregators[v] = a;
    }
    if (Object.keys(aggregators).length > 0) {
      out.valueAggregators = aggregators;
    }
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

  // PVT5 · the unified safety contract — see `isPivotDefaultsShapeSafe`.
  // The trace-row mismatch path (traceRowsMatchOutput=false → rowOut =
  // fromPreview.rows) can dump every non-numeric column into ROWS. Rather
  // than ship a config that nukes the user's UI, suppress entirely. Caller
  // (chatStream.service / agentLoop.service) sees `undefined` and emits
  // `pivotUnavailable: true` so the client renders the elegant fallback.
  if (!isPivotDefaultsShapeSafe(out)) return undefined;

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

  // Wave QL2 · two-pass selection. The deterministic aggregation-intent floor
  // (planner.ts → synthesizeAggregationStep) prepends a synthetic
  // `execute_query_plan` step whose `id` starts with `ql2_synth_`. That step
  // is the literal answer to the user's question (e.g. "average X per day
  // across all clusters" → groupBy=[Cluster Name] + perDimension=Day · X).
  // When the LLM also emits exploratory date-grouped or trend-style steps,
  // the original backward "last step wins" pass picked the LLM's plan and
  // showed the user a date-row table instead of the cluster-row table they
  // asked for. First pass prefers the synthesized floor; second pass keeps
  // the original last-step semantics for non-floor cases.
  let tracePlan: QueryPlanBody | undefined;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step?.tool !== "execute_query_plan") continue;
    const stepId = typeof step?.id === "string" ? step.id : "";
    if (!stepId.startsWith("ql2_synth_")) continue;
    const raw = (step?.args as Record<string, unknown> | undefined)?.plan;
    if (!raw || typeof raw !== "object") continue;
    const plan = raw as QueryPlanBody;
    const hints = collectTraceHintsFromPlan(plan, dataSummary);
    const hasDimensionFilters =
      Array.isArray(plan.dimensionFilters) && plan.dimensionFilters.length > 0;
    if (
      hints.traceRows.length > 0 ||
      hints.traceValues.length > 0 ||
      hints.traceAliasValues.length > 0 ||
      hasDimensionFilters
    ) {
      tracePlan = plan;
      break;
    }
  }
  if (!tracePlan) {
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
        hints.traceAliasValues.length > 0 ||
        hasDimensionFilters
      ) {
        tracePlan = plan;
        break;
      }
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
  if (tableRows.length <= 1) {
    if (tracePlan) {
      const scalarHints = collectTraceHintsFromPlan(tracePlan, dataSummary);
      if (scalarHints.traceRows.length === 0) {
        // Wave QL9.A · When the plan has aggregation aliases (or
        // `computedAggregations` aliases — the Wave QL7 ratio shape's
        // output columns), surface them as the pivot's VALUES so the
        // user sees the flat 1-row result. Without this, the pivot was
        // suppressed (`scalar: true`) and the UI fell back to the raw
        // dataset preview, showing irrelevant categorical columns.
        const previewKeys = previewOutputKeySet(tableColumns, tableRows);
        const aliasValuesInOutput = scalarHints.traceAliasValues.filter(
          (alias) => previewKeys.has(alias)
        );
        if (aliasValuesInOutput.length > 0) {
          return {
            rows: [],
            values: aliasValuesInOutput,
            scalar: false,
          };
        }
        // Fallback: true scalar with no aliases (synthesizer fallback path,
        // legacy plans). Suppress so callers don't fabricate dimensions.
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
    // Data-prep-only trace: the agent ran `add_computed_columns` and/or
    // `derive_dimension_bucket` (which return the full row-level frame with
    // the new column) and never followed up with a `execute_query_plan` or
    // other analytical aggregate. The `table` we have is the row-level frame
    // — feeding it into the schema-heuristic preview fallback would produce
    // a "every dim on ROWS" cascade. Suppress instead.
    const hasAnalyticalStep = steps.some((s) => {
      const tool = typeof s?.tool === "string" ? (s.tool as string) : "";
      return ANALYTICAL_TABLE_TOOLS.has(tool);
    });
    const hasDataPrepStep = steps.some((s) => {
      const tool = typeof s?.tool === "string" ? (s.tool as string) : "";
      return DATA_PREP_TOOLS.has(tool);
    });
    if (!hasAnalyticalStep && hasDataPrepStep) {
      return { rows: [], values: [], scalar: true };
    }

    const fromPreview = derivePivotDefaultsFromPreviewRows(
      tableRows,
      dataSummary,
      tableColumns.length ? tableColumns : null
    );
    if (!fromPreview?.rows?.length && !fromPreview?.values?.length) return undefined;

    // PVT2 · No execute_query_plan in this turn (e.g. agent used
    // `run_analytical_query`), but earlier analytical steps may still have
    // exposed an `aggregations[].alias` that bled into the result-table
    // columns. Scan ALL `execute_query_plan` steps in the trace and build
    // an alias→source map so we can recover the base column.
    //
    // Wave PAG1 · Same loop, also build `sourceToAgg` so non-trace-plan
    // turns whose earlier steps recorded the aggregation still surface the
    // aggregator hint to the client.
    const aliasToSource = new Map<string, string>();
    const sourceToAgg = new Map<string, PivotAggLiteral>();
    for (const s of steps) {
      if (s?.tool !== "execute_query_plan") continue;
      const planRaw = (s?.args as Record<string, unknown> | undefined)?.plan;
      if (!planRaw || typeof planRaw !== "object") continue;
      const aggList = (planRaw as { aggregations?: unknown }).aggregations;
      if (!Array.isArray(aggList)) continue;
      for (const agg of aggList) {
        if (!agg || typeof agg !== "object") continue;
        const a = agg as {
          column?: unknown;
          operation?: unknown;
          alias?: unknown;
          perDimension?: unknown;
        };
        const src = typeof a.column === "string" ? a.column.trim() : "";
        const operation = typeof a.operation === "string" ? a.operation : "";
        if (!src) continue;
        const explicitAlias = typeof a.alias === "string" ? a.alias.trim() : "";
        if (explicitAlias) aliasToSource.set(explicitAlias, src);
        if (operation) aliasToSource.set(`${src}_${operation}`, src);
        // PD1 · same nested-alias mirror as the merged-path branch.
        const perDim =
          typeof a.perDimension === "string" ? a.perDimension : "";
        if (operation && perDim) {
          const safePerDim = perDim
            .replace(/[^A-Za-z0-9_]+/g, "_")
            .replace(/^_+|_+$/g, "");
          aliasToSource.set(`${src}_${operation}_per_${safePerDim}`, src);
        }
        const mappedAgg = mapOperationToPivotAgg(operation);
        if (mappedAgg) sourceToAgg.set(src, mappedAgg);
      }
    }

    const numericSchema = new Set(dataSummary.numericColumns ?? []);
    const filteredValues: string[] = [];
    const seenFv = new Set<string>();
    for (const v of fromPreview.values ?? []) {
      const aliasMapped = aliasToSource.get(v) ?? v;
      const n = normalizePivotValueFieldForBaseTable(aliasMapped, dataSummary);
      // Strict: only ship value fields that exist on the base `data` table.
      // Aliases that can't be mapped back are dropped — pivot renders rows-
      // only rather than failing with a DuckDB binder error.
      if (!numericSchema.has(n)) continue;
      if (seenFv.has(n)) continue;
      seenFv.add(n);
      filteredValues.push(n);
    }

    const outRows = fromPreview.rows ?? [];
    if (outRows.length === 0 && filteredValues.length === 0) return undefined;

    const out: PivotDefaultsRowsValues = {
      rows: outRows,
      values: filteredValues,
    };
    if (fromPreview.columns?.length) {
      out.columns = [...fromPreview.columns];
    }
    if (filteredValues.length > 0 && sourceToAgg.size > 0) {
      const aggregators: Record<string, PivotAggLiteral> = {};
      for (const v of filteredValues) {
        const a = sourceToAgg.get(v);
        if (a) aggregators[v] = a;
      }
      if (Object.keys(aggregators).length > 0) {
        out.valueAggregators = aggregators;
      }
    }
    // PVT5 · same unified safety cap as the merged path. The no-tracePlan
    // path is the most common explosion vector — `run_analytical_query`
    // returns the result table to the categorizer, which buckets every
    // non-numeric column into ROWS. Cap and suppress.
    if (!isPivotDefaultsShapeSafe(out)) return undefined;
    return out;
  }

  return mergePivotDefaultRowsAndValues({
    dataSummary,
    tracePlan,
    tableRows,
    tableColumns,
  });
}
