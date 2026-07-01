/**
 * Wave W3 (data-bound cards) · the COMPOSE spine shared by the guided card
 * builder and the Executive-Summary KPI scorecards. Turns a selection-only
 * `dashboardCardDefinition` (measure × aggregation × filters) into a
 * `QueryPlanBody`, enforces the aggregation guardrail (you can't SUM a
 * percentage), and runs the plan against the dataset behind a session —
 * DuckDB-first for big data, in-memory otherwise.
 *
 * This module is deliberately thin: it REUSES the existing execution stack
 * (`queryPlanExecutor` / `queryPlanDuckdbExecutor`) and the metric-semantics
 * authority (`financeMetricAuthority` / column `semantics`) rather than
 * re-deriving aggregation rules.
 */

import type {
  DashboardCardDefinition,
  DataSummary,
  SemanticModel,
} from "../shared/schema.js";
import type { ChatDocument } from "../models/chat.model.js";
import {
  executeQueryPlan,
  type QueryPlanBody,
} from "./queryPlanExecutor.js";
import { executeQueryPlanOnDuckDb } from "./queryPlanDuckdbExecutor.js";
import { isDuckDBAvailable, type ColumnarStorageService } from "./columnarStorage.js";
import { classifyMetric } from "./financeMetricAuthority.js";

/** The card-level aggregation vocabulary (a subset of the executor's aggOps). */
export type CardAggregation =
  | "sum"
  | "avg"
  | "count"
  | "min"
  | "max"
  | "median";

export type MeasureAdditivity = "additive" | "non_additive" | "none";

export interface AllowedAggregations {
  additivity: MeasureAdditivity;
  allowed: CardAggregation[];
  defaultAggregation: CardAggregation;
}

const ADDITIVE_ALLOWED: CardAggregation[] = [
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "median",
];
// Non-additive (ratio / per-unit) → averaging only. SUM is the whole point of
// the guardrail: a percentage can't be summed across a dimension.
const NON_ADDITIVE_ALLOWED: CardAggregation[] = ["avg"];
const DIMENSIONLESS_ALLOWED: CardAggregation[] = ["count"];

/**
 * The additivity of a measure ref — column `semantics`/`additivity` first
 * (the deterministic upload-time authority), then the curated semantic-model
 * metric's `format`/`expression`, then a name-based `financeMetricAuthority`
 * fallback. `none` = a dimension-ish column that can only be counted.
 */
export function resolveMeasureAdditivity(
  measureRef: string,
  summary: DataSummary,
  model?: SemanticModel | null
): MeasureAdditivity {
  const col = summary.columns.find((c) => c.name === measureRef);
  if (col) {
    const semAgg = col.semantics?.aggregation;
    if (semAgg === "none") return "none";
    if (
      col.additivity === "non_additive" ||
      (col.additivityKind && col.additivityKind !== "additive") ||
      semAgg === "avg"
    ) {
      return "non_additive";
    }
    if (semAgg === "sum" || col.additivity === "additive") return "additive";
    // Numeric column with no semantic tag → treat as additive (sum-able).
    return "additive";
  }
  const metric = model?.metrics?.find(
    (m) => m.name === measureRef || m.label === measureRef
  );
  if (metric) {
    return classifyMetric(measureRef, {
      format: metric.format,
      expression: metric.expression,
      references: metric.references,
    }).additivity;
  }
  return classifyMetric(measureRef).additivity;
}

/**
 * The aggregation guardrail surface: which aggregations are LEGAL for a
 * measure, and the sensible default. Both the client picker (greys the
 * illegal ones) and the server (rejects them) read this one authority.
 */
export function resolveAllowedAggregations(
  measureRef: string,
  summary: DataSummary,
  model?: SemanticModel | null
): AllowedAggregations {
  const additivity = resolveMeasureAdditivity(measureRef, summary, model);
  if (additivity === "none") {
    return { additivity, allowed: DIMENSIONLESS_ALLOWED, defaultAggregation: "count" };
  }
  if (additivity === "non_additive") {
    return { additivity, allowed: NON_ADDITIVE_ALLOWED, defaultAggregation: "avg" };
  }
  return { additivity, allowed: ADDITIVE_ALLOWED, defaultAggregation: "sum" };
}

/** Infer a scorecard display format from a measure column's semantics. */
export function deriveScorecardFormat(
  measureRef: string,
  summary: DataSummary
): { format: "number" | "percent" | "currency" | "ratio" | "duration"; currencyCode?: string } {
  const col = summary.columns.find((c) => c.name === measureRef);
  const currency = (col as { currency?: { isoCode?: string } } | undefined)?.currency;
  if (currency?.isoCode) return { format: "currency", currencyCode: currency.isoCode };
  const st = col?.semantics?.semanticType;
  if (st === "measure_ratio_percent") return { format: "percent" };
  if (st === "currency_amount") return { format: "currency" };
  return { format: "number" };
}

// ────────────────────────────────────────────────────────────────────────────
// Builder metadata — the picker's data source (Wave W9)
// ────────────────────────────────────────────────────────────────────────────

export interface BuilderMeasure {
  ref: string;
  kind: "metric" | "column";
  label: string;
  format: "number" | "percent" | "currency" | "ratio" | "duration";
  currencyCode?: string;
  allowedAggregations: CardAggregation[];
  defaultAggregation: CardAggregation;
}

export interface BuilderDimension {
  column: string;
  label: string;
  kind: "categorical" | "temporal";
  /** Distinct values for filter dropdowns (only for low-cardinality columns). */
  values?: { value: string | number; count: number }[];
  hasTopValues: boolean;
}

export interface BuilderMetadata {
  measures: BuilderMeasure[];
  dimensions: BuilderDimension[];
}

/**
 * Build the guided-card-builder metadata for a dataset: the measures (with
 * their LEGAL aggregations + default), and the dimensions (with distinct
 * values for the filter dropdowns). This is what makes the builder
 * selection-only — the client can only pick what this returns.
 */
export function buildBuilderMetadata(
  summary: DataSummary,
  model?: SemanticModel | null
): BuilderMetadata {
  const measures: BuilderMeasure[] = [];
  const seen = new Set<string>();

  // Curated semantic-model metrics first (friendly, business-named).
  for (const m of model?.metrics ?? []) {
    if (m.exposed === false) continue;
    const g = resolveAllowedAggregations(m.name, summary, model);
    measures.push({
      ref: m.name,
      kind: "metric",
      label: m.label ?? m.name,
      format: (m.format as BuilderMeasure["format"]) ?? "number",
      ...(m.currencyCode ? { currencyCode: m.currencyCode } : {}),
      allowedAggregations: g.allowed,
      defaultAggregation: g.defaultAggregation,
    });
    seen.add(m.name.toLowerCase());
  }

  // Numeric columns that are real measures (skip ids / ordinals).
  for (const name of summary.numericColumns ?? []) {
    if (seen.has(name.toLowerCase())) continue;
    if (resolveMeasureAdditivity(name, summary, model) === "none") continue;
    const g = resolveAllowedAggregations(name, summary, model);
    const fmt = deriveScorecardFormat(name, summary);
    measures.push({
      ref: name,
      kind: "column",
      label: name,
      format: fmt.format,
      ...(fmt.currencyCode ? { currencyCode: fmt.currencyCode } : {}),
      allowedAggregations: g.allowed,
      defaultAggregation: g.defaultAggregation,
    });
    seen.add(name.toLowerCase());
  }

  const dimensions: BuilderDimension[] = [];
  const dateColumns = new Set(summary.dateColumns ?? []);
  for (const col of summary.columns) {
    const st = col.semantics?.semanticType;
    const dk = col.semantics?.displayKind;
    const isTemporal = !!st?.startsWith("temporal_") || dk === "date" || dateColumns.has(col.name);
    const isCategorical =
      (dk === "categorical" || dk === "ordinal") && st !== "identifier";
    // Legacy (no semantics): a text column with topValues is a categorical dim.
    const legacyCat = !col.semantics && col.type === "text" && (col.topValues?.length ?? 0) > 0;
    if (!isTemporal && !isCategorical && !legacyCat) continue;
    // A hidden temporal-facet column isn't user-pickable.
    if (col.name.startsWith("__tf_") || / · /.test(col.name)) continue;
    dimensions.push({
      column: col.name,
      label: col.name,
      kind: isTemporal ? "temporal" : "categorical",
      ...(col.topValues && col.topValues.length > 0 ? { values: [...col.topValues] } : {}),
      hasTopValues: (col.topValues?.length ?? 0) > 0,
    });
  }

  return { measures, dimensions };
}

export type CompileCardResult =
  | {
      ok: true;
      plan: QueryPlanBody;
      /** The row key that carries the aggregated measure value. */
      alias: string;
      measureColumn: string;
      aggregation: CardAggregation;
    }
  | { ok: false; error: string; allowed?: CardAggregation[] };

/** A pure `SUM(col)` / `AVG(col)` expression → the underlying column name. */
const SINGLE_AGG_RE = /^\s*(sum|avg|mean|min|max|median|count)\s*\(\s*([^)]+?)\s*\)\s*$/i;

/**
 * Resolve a card measure to the physical column the plan aggregates. A
 * "column" measure is that column; a "metric" measure resolves to its column
 * when it's a same-named column or a pure single-aggregation expression.
 */
function resolveMeasureColumn(
  def: DashboardCardDefinition,
  summary: DataSummary,
  model?: SemanticModel | null
): { column: string } | { error: string } {
  const ref = def.measure.ref;
  if (summary.columns.some((c) => c.name === ref)) return { column: ref };
  if (def.measure.kind === "metric") {
    const metric = model?.metrics?.find(
      (m) => m.name === ref || m.label === ref
    );
    if (metric?.expression) {
      const m = SINGLE_AGG_RE.exec(metric.expression);
      const inner = m?.[2]?.trim().replace(/^["'`]|["'`]$/g, "");
      if (inner && summary.columns.some((c) => c.name === inner)) {
        return { column: inner };
      }
      return {
        error: `Composite metric '${ref}' can't be composed into a single-column card yet — pick an underlying column.`,
      };
    }
  }
  return { error: `Unknown measure '${ref}'.` };
}

/**
 * Compile a card definition into an executable `QueryPlanBody`, enforcing the
 * aggregation guardrail. Returns a structured error (with `allowed`) when the
 * requested aggregation is illegal for the measure (e.g. sum-on-ratio).
 */
export function compileCardSpecToPlan(
  def: DashboardCardDefinition,
  summary: DataSummary,
  model?: SemanticModel | null
): CompileCardResult {
  const resolved = resolveMeasureColumn(def, summary, model);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const measureColumn = resolved.column;

  const guard = resolveAllowedAggregations(def.measure.ref, summary, model);
  if (!guard.allowed.includes(def.aggregation)) {
    const isRatioSum =
      def.aggregation === "sum" && guard.additivity === "non_additive";
    return {
      ok: false,
      error: isRatioSum ? "cannot_sum_non_additive" : "invalid_aggregation",
      allowed: guard.allowed,
    };
  }

  // Card aggregation names map 1:1 onto the executor's aggOps (it accepts both
  // "avg" and "mean"; we keep "avg").
  const alias = measureColumn;
  const dimensionFilters = (def.filters ?? []).map((f) => ({
    column: f.column,
    op: f.op ?? ("in" as const),
    values: f.values.map((v) => String(v)),
  }));
  const plan: QueryPlanBody = {
    groupBy: def.groupBy && def.groupBy.length > 0 ? [...def.groupBy] : [],
    aggregations: [
      { column: measureColumn, operation: def.aggregation, alias },
    ],
    ...(dimensionFilters.length > 0 ? { dimensionFilters } : {}),
  };

  return { ok: true, plan, alias, measureColumn, aggregation: def.aggregation };
}

export interface RunComposePlanArgs {
  sessionId?: string | null;
  chat?: ChatDocument | null;
  summary: DataSummary;
  plan: QueryPlanBody;
  /** In-memory fallback data loader (used only when DuckDB is unavailable). */
  loadRows?: () => Promise<Record<string, any>[]>;
  signal?: AbortSignal;
  sharedStorage?: ColumnarStorageService;
}

export type RunComposePlanResult =
  | { ok: true; rows: Record<string, any>[] }
  | { ok: false; error: string };

/**
 * Execute a compiled plan against the session's dataset. DuckDB-first (never
 * materialises a giant JS array for ≥10k-row sessions); falls back to the
 * in-memory executor over `loadRows()` when DuckDB is unavailable (tests /
 * small sessions).
 */
export async function runComposePlan(
  args: RunComposePlanArgs
): Promise<RunComposePlanResult> {
  if (isDuckDBAvailable() && args.sessionId) {
    const res = await executeQueryPlanOnDuckDb(
      args.sessionId,
      args.plan,
      args.summary,
      args.chat ?? null,
      args.signal,
      args.sharedStorage
    );
    return res.ok
      ? { ok: true, rows: res.rows as Record<string, any>[] }
      : { ok: false, error: res.error };
  }
  if (!args.loadRows) {
    return {
      ok: false,
      error:
        "no data source: DuckDB unavailable and no in-memory loadRows provided",
    };
  }
  const rows = await args.loadRows();
  const res = executeQueryPlan(rows, args.summary, args.plan);
  return res.ok ? { ok: true, rows: res.data } : { ok: false, error: res.error };
}
