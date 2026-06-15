/**
 * Run agent execute_query_plan-style aggregations on the authoritative columnar
 * DuckDB `data` table so results match pivot (materialized temporal facets).
 */

import type { ChatDocument } from "../models/chat.model.js";
import type { DataSummary } from "../shared/schema.js";
import { ColumnarStorageService } from "./columnarStorage.js";
import { isDuckDBAvailable } from "./columnarStorage.js";
import { ensureAuthoritativeDataTable } from "./ensureSessionDuckdbMaterialized.js";
import { resolveSessionDataTable } from "./activeFilter/resolveSessionDataTable.js";
import type { QueryPlanBody } from "./queryPlanExecutor.js";
import {
  clearRedundantDateAggregationForTemporalFacets,
  parseComputedAggregationExpression,
} from "./queryPlanExecutor.js";
import { isIdColumn, getCountNameForIdColumn } from "./columnIdHeuristics.js";
import {
  buildDisplayToLegacyFacetMap,
  duckPhysicalColumnName,
  facetColumnInlineDuckDbExpr,
} from "./temporalFacetColumns.js";
import { quoteIdent, escapeSqlStringLiteral } from "./pivotFilterSql.js";
import { errorMessage } from "../utils/errorMessage.js";

const DATA_TABLE = "data";

/** Dimension filter cell expression for SQL (exact / case_insensitive / contains). */
function dimensionMatchExpr(column: string, match?: string): string {
  const q = quoteIdent(column);
  if (match === "case_insensitive" || match === "contains") {
    return `LOWER(TRIM(CAST(${q} AS VARCHAR)))`;
  }
  return `TRIM(CAST(${q} AS VARCHAR))`;
}

function escapeLikePattern(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

type DimensionFilterLike = NonNullable<QueryPlanBody["dimensionFilters"]>[number];

/**
 * Compile a single DimensionFilter to a SQL boolean expression. Returns null
 * when the filter is unusable (no column / no values). Reused by:
 *   1. top-level WHERE compilation (`buildWhereClause`)
 *   2. PCT1 conditional-aggregation predicates (`countIf`/`sumIf`)
 */
/**
 * CMP1 · Detect whether a comparison value should be compared as a number
 * (`TRY_CAST(col AS DOUBLE)` against a numeric literal) or as a string
 * (HH:MM:SS time-of-day, ISO dates, raw text). Heuristic: parse the string —
 * pure numeric → numeric path; anything else → string path. The TRY_CAST
 * gracefully returns NULL on rows that can't cast, so a numeric comparison
 * over a mixed column never throws.
 */
function isNumericComparisonValue(v: string): boolean {
  const t = v.trim();
  if (t.length === 0) return false;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return false;
  const n = Number(t);
  return Number.isFinite(n);
}

const COMPARISON_OP_TO_SQL: Record<string, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function compileDimensionFilterToSql(
  filter: DimensionFilterLike,
  physicalOf: (logical: string) => string
): { sql: string; description: string } | null {
  if (!filter.column || !filter.values?.length) return null;
  const physCol = physicalOf(filter.column);

  // CMP1 · scalar comparison ops: eq/neq/lt/lte/gt/gte
  if (filter.op in COMPARISON_OP_TO_SQL) {
    const v = filter.values[0]?.trim();
    if (v === undefined || v.length === 0) return null;
    const opSql = COMPARISON_OP_TO_SQL[filter.op]!;
    const q = quoteIdent(physCol);
    const sql = isNumericComparisonValue(v)
      ? `TRY_CAST(${q} AS DOUBLE) ${opSql} ${v}`
      : `CAST(${q} AS VARCHAR) ${opSql} ${escapeSqlStringLiteral(v)}`;
    const description = `${filter.column} ${opSql} ${v}`;
    return { sql, description };
  }

  // CMP1 · between [low, high] inclusive
  if (filter.op === "between") {
    if (filter.values.length < 2) return null;
    const lo = filter.values[0]?.trim();
    const hi = filter.values[1]?.trim();
    if (!lo || !hi) return null;
    const q = quoteIdent(physCol);
    const sql =
      isNumericComparisonValue(lo) && isNumericComparisonValue(hi)
        ? `TRY_CAST(${q} AS DOUBLE) BETWEEN ${lo} AND ${hi}`
        : `CAST(${q} AS VARCHAR) BETWEEN ${escapeSqlStringLiteral(lo)} AND ${escapeSqlStringLiteral(hi)}`;
    return {
      sql,
      description: `${filter.column} between ${lo} and ${hi}`,
    };
  }

  // Categorical in / not_in (with match modes)
  const mode = filter.match || "exact";
  const expr = dimensionMatchExpr(physCol, mode);

  let pred: string;
  if (mode === "contains") {
    const likeParts = filter.values
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
      .map(
        (v) =>
          `${expr} LIKE ${escapeSqlStringLiteral(`%${escapeLikePattern(v)}%`)} ESCAPE '\\'`
      );
    if (likeParts.length === 0) return null;
    const matchAny = likeParts.length > 1 ? `(${likeParts.join(" OR ")})` : likeParts[0]!;
    pred = filter.op === "in" ? matchAny : `NOT ${matchAny}`;
  } else {
    const vals = filter.values.map((v) => {
      const t = v.trim();
      return mode === "case_insensitive" ? t.toLowerCase() : t;
    });
    const list = vals.map((v) => escapeSqlStringLiteral(v)).join(", ");
    pred =
      filter.op === "in"
        ? `${expr} IN (${list})`
        : `NOT (${expr} IN (${list}))`;
  }

  const descVals = filter.values.join(", ");
  const description =
    filter.op === "in"
      ? `${filter.column} in [${descVals}] (${mode})`
      : `${filter.column} not in [${descVals}] (${mode})`;
  return { sql: pred, description };
}

/** PCT1 · ANDed predicate compilation for countIf/sumIf. Returns null when
 *  every entry was unusable; otherwise the joined SQL boolean expression. */
function compilePredicateToSql(
  predicate: ReadonlyArray<DimensionFilterLike> | undefined,
  physicalOf: (logical: string) => string
): string | null {
  if (!predicate?.length) return null;
  const parts: string[] = [];
  for (const f of predicate) {
    const compiled = compileDimensionFilterToSql(f, physicalOf);
    if (compiled) parts.push(compiled.sql);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
}

function buildWhereClause(
  plan: QueryPlanBody,
  physicalOf: (logical: string) => string
): { sql: string; descriptions: string[] } {
  const descriptions: string[] = [];
  const parts: string[] = [];
  for (const filter of plan.dimensionFilters ?? []) {
    const compiled = compileDimensionFilterToSql(filter, physicalOf);
    if (!compiled) continue;
    parts.push(compiled.sql);
    descriptions.push(compiled.description);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1=1", descriptions };
}

function aggregationSqlExpr(
  columnLogical: string,
  columnPhysical: string,
  operation: NonNullable<QueryPlanBody["aggregations"]>[0]["operation"],
  predicateSql: string | null
): string {
  const q = quoteIdent(columnPhysical);
  switch (operation) {
    case "sum":
      return `SUM(TRY_CAST(${q} AS DOUBLE))`;
    case "mean":
    case "avg":
      return `AVG(TRY_CAST(${q} AS DOUBLE))`;
    case "min":
      return `MIN(TRY_CAST(${q} AS DOUBLE))`;
    case "max":
      return `MAX(TRY_CAST(${q} AS DOUBLE))`;
    case "count":
      if (isIdColumn(columnLogical)) {
        return `COUNT(DISTINCT ${q})`;
      }
      return `COUNT(*)`;
    case "count_distinct":
      // Wave QL7 · COUNT(DISTINCT col). First-class denominator for the
      // ratio shape (SUM(metric) / COUNT(DISTINCT denom)). Null/empty
      // values are excluded by SQL COUNT(DISTINCT) semantics; the
      // in-memory executor's Set-based count matches this contract.
      return `COUNT(DISTINCT ${q})`;
    case "countIf":
      // PCT1 · `COUNT(CASE WHEN <pred> THEN 1 END)` — the column is irrelevant
      // for countIf (we count predicate-matching rows). The predicate is
      // already ANDed and parenthesised by `compilePredicateToSql`.
      if (!predicateSql) return "";
      return `COUNT(CASE WHEN ${predicateSql} THEN 1 END)`;
    case "sumIf":
      if (!predicateSql) return "";
      return `SUM(CASE WHEN ${predicateSql} THEN TRY_CAST(${q} AS DOUBLE) END)`;
    default:
      return "";
  }
}

function outputAliasForAgg(
  column: string,
  operation: NonNullable<QueryPlanBody["aggregations"]>[0]["operation"],
  alias?: string,
  perDimension?: string
): string {
  if (alias?.trim()) return alias.trim();
  if (operation === "count" && isIdColumn(column)) {
    return getCountNameForIdColumn(column);
  }
  // PCT1 · countIf has no meaningful column name; default alias "matching"
  // when none supplied. Plans should still set their own alias for clarity.
  if (operation === "countIf") return "matching";
  if (operation === "sumIf") return `${column}_sumIf`;
  // PD1 · nested aggregation aliases sanitise the perDimension column name
  // (which may contain `·` or spaces in temporal facet names) into an
  // identifier-safe suffix.
  if (perDimension) {
    const safePerDim = perDimension.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    return `${column}_${operation}_per_${safePerDim}`;
  }
  return `${column}_${operation}`;
}

/**
 * PD1 · returns the set of distinct `perDimension` values across the plan's
 * aggregations. Empty set means a flat (non-nested) plan. Cardinality > 1
 * means a mixed plan (some aggs nested, some not, or different perDimensions)
 * which the v1 nested-aggregation builder rejects — the planner must split
 * into separate plans or the deterministic repair must align them.
 */
export function aggregationsPerDimensionsInPlan(
  plan: QueryPlanBody
): Set<string> {
  const set = new Set<string>();
  for (const a of plan.aggregations ?? []) {
    if (a.perDimension) set.add(a.perDimension);
  }
  return set;
}

/**
 * PD1 · true when at least one aggregation has `perDimension` set. Used by
 * pivotDefaultsFromExecution / Key Insight text generator to branch.
 */
export function aggregationsHaveNested(plan: QueryPlanBody): boolean {
  return aggregationsPerDimensionsInPlan(plan).size > 0;
}

/**
 * Wave W1 · Build the SQL for a single window aggregation. Used in the
 * derived-subquery wrap at the top of `buildQueryPlanDuckdbSql` so the
 * window's output column becomes a first-class source column for the
 * rest of the plan.
 *
 * Emits standard SQL window-function syntax compatible with DuckDB:
 *   <op>([col]) OVER (
 *     [PARTITION BY ...]
 *     ORDER BY ...
 *     [<frame>]
 *   ) AS <alias>
 *
 * The aliases passed in are already validated upstream by Zod
 * (`windowAggregationSchema`) — alphanumeric + underscore + max 64 chars
 * — so direct interpolation is safe.
 */
function buildWindowAggregationSql(
  w: import("./queryPlanExecutor.js").WindowAggregation
): string {
  const partition = (w.partitionBy ?? [])
    .map((c) => quoteIdent(c))
    .join(", ");
  const order = w.orderBy
    .map(
      (ob) =>
        `${quoteIdent(ob.column)} ${ob.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`
    )
    .join(", ");
  const partitionClause = partition ? `PARTITION BY ${partition} ` : "";

  // Frame clause (only for aggregates, not ranking / lag / lead).
  let frame = "";
  const isRanking =
    w.operation === "row_number" ||
    w.operation === "rank" ||
    w.operation === "dense_rank";
  const isLagLead = w.operation === "lag" || w.operation === "lead";
  if (!isRanking && !isLagLead && w.frame) {
    if ("rows" in w.frame) {
      const n = w.frame.rows;
      frame = ` ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW`;
    } else if ("range" in w.frame && w.frame.range === "unbounded_preceding") {
      frame = " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";
    }
  }

  // Function expression.
  let fnExpr: string;
  if (w.operation === "row_number") {
    fnExpr = "ROW_NUMBER()";
  } else if (w.operation === "rank") {
    fnExpr = "RANK()";
  } else if (w.operation === "dense_rank") {
    fnExpr = "DENSE_RANK()";
  } else if (w.operation === "lag" || w.operation === "lead") {
    const offset = w.offset ?? 1;
    fnExpr = `${w.operation.toUpperCase()}(${quoteIdent(w.column!)}, ${offset})`;
  } else {
    // sum / mean / min / max / count
    const sqlOp =
      w.operation === "mean" ? "AVG" : w.operation.toUpperCase();
    fnExpr = `${sqlOp}(${quoteIdent(w.column!)})`;
  }

  return `${fnExpr} OVER (${partitionClause}ORDER BY ${order}${frame}) AS ${quoteIdent(w.alias)}`;
}

export function canExecuteQueryPlanOnDuckDb(plan: QueryPlanBody): boolean {
  const p = clearRedundantDateAggregationForTemporalFacets(plan);
  if (!p.aggregations?.length) return false;
  if (p.dateAggregationPeriod != null && p.dateAggregationPeriod !== undefined) {
    return false;
  }
  for (const a of p.aggregations) {
    if (a.operation === "median" || a.operation === "percent_change") return false;
    // PCT1 · countIf/sumIf must carry a non-empty predicate; the schema
    // refinement enforces this, but defend at the executor too.
    if ((a.operation === "countIf" || a.operation === "sumIf") && !a.predicate?.length) {
      return false;
    }
  }
  // PD1 · nested-aggregation v1 contract: when ANY aggregation has
  // perDimension, ALL aggregations must share the SAME perDimension. Mixed
  // plans (some flat, some nested, or different perDimensions) aren't
  // supported in v1 — the deterministic repair aligns them; an LLM-emitted
  // mixed plan falls back to single-stage execution by returning false here.
  const perDims = aggregationsPerDimensionsInPlan(p);
  if (perDims.size > 0) {
    if (perDims.size > 1) return false;
    const allHavePerDim = (p.aggregations ?? []).every(
      (a) => typeof a.perDimension === "string" && a.perDimension.length > 0
    );
    if (!allHavePerDim) return false;
    // No nested countIf/sumIf — superRefine already rejected predicate +
    // perDimension; defence in depth here.
    for (const a of p.aggregations ?? []) {
      if (a.operation === "countIf" || a.operation === "sumIf") return false;
    }
  }
  // Wave W5: `contains` is now handled via LIKE in buildWhereClause; no longer a fallback trigger.
  return true;
}

export interface BuildQueryPlanDuckdbSqlResult {
  aggregateSql: string;
  countSql: string;
  descriptions: string[];
  /** WPF3 · Columns the executor must strip from result rows after the query
   *  runs (currently the hidden PeriodIso column added for chronological
   *  ORDER BY when groupBy includes the wide-format Period column). */
  hiddenColumns?: string[];
}

/** When set, facet columns in the plan use UI ids; DuckDB may still store legacy `__tf_*` names. */
export interface DuckDbQueryPlanBuildContext {
  tableColumns: Set<string>;
  summary: DataSummary;
  /**
   * Wave-FA2 · Override the table name the SQL should target. Default `data`
   * (canonical authoritative table). Pass `data_filtered` (resolved via
   * `resolveSessionDataTable`) to apply the per-session active-filter overlay.
   */
  tableName?: string;
}

export function buildQueryPlanDuckdbSql(
  plan: QueryPlanBody,
  ctx?: DuckDbQueryPlanBuildContext
): BuildQueryPlanDuckdbSqlResult | null {
  if (!canExecuteQueryPlanOnDuckDb(plan)) return null;
  const p = clearRedundantDateAggregationForTemporalFacets(plan);
  const displayToLegacy = ctx
    ? buildDisplayToLegacyFacetMap(ctx.summary)
    : null;
  const physicalOf = (logical: string): string =>
    ctx && displayToLegacy
      ? duckPhysicalColumnName(logical, ctx.tableColumns, displayToLegacy)
      : logical;

  const { sql: whereSql, descriptions: filterDesc } = buildWhereClause(
    p,
    physicalOf
  );
  if (whereSql === "" && (p.dimensionFilters?.length ?? 0) > 0) {
    return null;
  }

  const groupBy = p.groupBy ?? [];
  const selectParts: string[] = [];
  const groupParts: string[] = [];

  // WPF3 · When the dataset was melted from wide format AND the planner
  // grouped by the human-readable Period column, also add the canonical
  // PeriodIso column so we can ORDER BY it (chronological order). The ISO
  // column is stripped from result rows below so the planner / narrator /
  // chart compiler don't see the duplicate.
  const wf = ctx?.summary.wideFormatTransform;
  const periodColumn = wf?.detected ? wf.periodColumn : undefined;
  const periodIsoColumn = wf?.detected ? wf.periodIsoColumn : undefined;
  const groupedByPeriod = !!(
    periodColumn && periodIsoColumn && groupBy.includes(periodColumn)
  );
  const isoInTable = !!(
    periodIsoColumn && ctx?.tableColumns.has(periodIsoColumn)
  );
  const shouldHideIsoFromResults =
    groupedByPeriod && isoInTable && !groupBy.includes(periodIsoColumn!);

  for (const g of groupBy) {
    const qLog = quoteIdent(g);
    // W13 (revised): prefer the materialized temporal facet column when it
    // exists in the DuckDB table — it was computed correctly by the upload
    // pipeline. Only fall back to an inline SQL expression when the column is
    // absent (old sessions / failed uploads), because the inline TRY_CAST can
    // silently return null when Order Date is stored as an ISO datetime string
    // that DuckDB cannot auto-cast to DATE, collapsing all rows to one null group.
    const materializedExists = ctx?.tableColumns.has(g);
    // For a melted period dimension, the inline expr derives the grain from the
    // canonical PeriodIso column instead of date-casting the Period label
    // (which is NULL for "Q1 23" / "YTD 2YA" and collapses every row to one
    // null group → 0 rows for a `Quarter · Period` between-filter).
    const pdForInline =
      wf?.detected && periodColumn && periodIsoColumn
        ? { periodCol: periodColumn, isoCol: periodIsoColumn }
        : undefined;
    const inlineExpr =
      !materializedExists && ctx
        ? facetColumnInlineDuckDbExpr(g, ctx.tableColumns, pdForInline)
        : null;
    if (inlineExpr) {
      selectParts.push(`${inlineExpr} AS ${qLog}`);
      groupParts.push(inlineExpr);
      continue;
    }
    const phys = physicalOf(g);
    if (phys === g) {
      selectParts.push(`${qLog} AS ${qLog}`);
      groupParts.push(qLog);
    } else {
      const qPhys = quoteIdent(phys);
      selectParts.push(`${qPhys} AS ${qLog}`);
      groupParts.push(qPhys);
    }
  }

  // PD1 · branch on nested aggregations. When perDimension is set on all
  // aggregations (uniform contract enforced by `canExecuteQueryPlanOnDuckDb`),
  // build a derived-table subquery: inner SELECT buckets by groupBy +
  // perDimension with `innerOperation` (default "sum"); outer SELECT applies
  // `operation` across the bucket totals. Closes the "average X per Y" gap.
  const perDimsInPlan = aggregationsPerDimensionsInPlan(p);
  const isNestedPlan = perDimsInPlan.size === 1;
  const perDimensionForPlan = isNestedPlan ? [...perDimsInPlan][0]! : null;

  if (!isNestedPlan) {
    for (const agg of p.aggregations ?? []) {
      const colPhys = physicalOf(agg.column);
      // PCT1 · compile predicate once per aggregation so countIf/sumIf can fold
      // it into a CASE WHEN. Other ops ignore predicateSql.
      const predicateSql = compilePredicateToSql(agg.predicate, physicalOf);
      const expr = aggregationSqlExpr(agg.column, colPhys, agg.operation, predicateSql);
      if (!expr) return null;
      const alias = outputAliasForAgg(agg.column, agg.operation, agg.alias);
      selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
    }
  }

  // WPF3 · Hidden ISO column: include in SELECT + GROUP BY so we can ORDER
  // BY it chronologically. Stripped from result rows below.
  if (!isNestedPlan && shouldHideIsoFromResults && periodIsoColumn) {
    const qIso = quoteIdent(periodIsoColumn);
    selectParts.push(`${qIso} AS ${qIso}`);
    groupParts.push(qIso);
  }

  // Wave W1 · When windowAggregations are present, wrap the source
  // table in a derived-subquery that adds the window-function output
  // columns up-front. The rest of the planner's SQL builder operates
  // against this wrapped expression as if it were the source table.
  const baseTableExpr = quoteIdent(ctx?.tableName ?? DATA_TABLE);
  const windowAggs = (p as QueryPlanBody).windowAggregations;
  let tableExpr: string;
  if (Array.isArray(windowAggs) && windowAggs.length > 0) {
    const windowClauses: string[] = [];
    for (const w of windowAggs) {
      windowClauses.push(buildWindowAggregationSql(w));
    }
    tableExpr = `(SELECT *, ${windowClauses.join(", ")} FROM ${baseTableExpr}) ${quoteIdent("w1_windowed")}`;
  } else {
    tableExpr = baseTableExpr;
  }
  let sql: string;
  if (isNestedPlan && perDimensionForPlan) {
    // PD1 · derived-table subquery:
    //   SELECT outerGroupBy, <outerOp>(unit_total_i) AS alias_i
    //   FROM (
    //     SELECT outerGroupBy, <perDim> AS __pd_bucket__,
    //            <innerOp>(col_i) AS unit_total_i
    //     FROM <tableExpr> WHERE <whereClause>
    //     GROUP BY outerGroupBy, __pd_bucket__
    //   ) sub
    //   GROUP BY outerGroupBy
    //
    // Inner-SELECT pieces reuse groupBy resolution (materialized facet
    // column / inline TRY_CAST expr / physical name) but emit them under
    // the LOGICAL alias so the outer SELECT can reference them by name.
    const innerSelectParts: string[] = [];
    const innerGroupParts: string[] = [];
    for (const g of groupBy) {
      const qLog = quoteIdent(g);
      const materializedExists = ctx?.tableColumns.has(g);
      const inlineExpr =
        !materializedExists && ctx
          ? facetColumnInlineDuckDbExpr(g, ctx.tableColumns)
          : null;
      if (inlineExpr) {
        innerSelectParts.push(`${inlineExpr} AS ${qLog}`);
        innerGroupParts.push(inlineExpr);
        continue;
      }
      const phys = physicalOf(g);
      if (phys === g) {
        innerSelectParts.push(`${qLog} AS ${qLog}`);
        innerGroupParts.push(qLog);
      } else {
        const qPhys = quoteIdent(phys);
        innerSelectParts.push(`${qPhys} AS ${qLog}`);
        innerGroupParts.push(qPhys);
      }
    }
    // perDimension bucket — same materialized-vs-inline logic as groupBy.
    // PD2 · Resolvability guard: if `ctx` is provided, the perDimension must
    // either (a) be a materialized column in tableColumns, (b) have an inline
    // TRY_CAST expression available (its source date column lives in
    // tableColumns), or (c) have a legacy `__tf_*` mapping via physicalOf
    // (different from the input). When all three fail, DuckDB would throw
    // "column not found" at execute time — return null upfront so the caller
    // can fail cleanly instead of leaking a binder error.
    const pdMaterialized = ctx?.tableColumns.has(perDimensionForPlan);
    const pdInline =
      !pdMaterialized && ctx
        ? facetColumnInlineDuckDbExpr(perDimensionForPlan, ctx.tableColumns)
        : null;
    let pdExpr: string;
    if (pdMaterialized) {
      const phys = physicalOf(perDimensionForPlan);
      pdExpr = quoteIdent(phys);
    } else if (pdInline) {
      pdExpr = pdInline;
    } else if (ctx) {
      // ctx is provided but neither path resolved. Try the legacy mapping
      // one last time — physicalOf returns a different name if displayToLegacy
      // remapped (e.g., "Day · Date" → "__tf_date__Date" that IS in the table).
      const pdPhys = physicalOf(perDimensionForPlan);
      if (pdPhys !== perDimensionForPlan && ctx.tableColumns.has(pdPhys)) {
        pdExpr = quoteIdent(pdPhys);
      } else {
        // No resolution path. Bail to single-pass / error rather than emit
        // unexecutable SQL.
        return null;
      }
    } else {
      // No ctx (synthetic / test path) — fall back to the legacy assume-
      // the-column-exists behavior so existing PD1 tests stay green.
      const pdPhys = physicalOf(perDimensionForPlan);
      pdExpr = quoteIdent(pdPhys);
    }
    innerSelectParts.push(`${pdExpr} AS "__pd_bucket__"`);
    innerGroupParts.push(pdExpr);

    // Inner aggregations: SUM (default) of the raw column per bucket. The
    // alias on the inner SELECT must match what the outer references.
    const innerAggAliases: string[] = [];
    for (const agg of p.aggregations ?? []) {
      const colPhys = physicalOf(agg.column);
      const innerOp = agg.innerOperation ?? "sum";
      const innerExpr = aggregationSqlExpr(agg.column, colPhys, innerOp, null);
      if (!innerExpr) return null;
      const innerAlias = `__unit_total_${innerAggAliases.length}__`;
      innerSelectParts.push(`${innerExpr} AS ${quoteIdent(innerAlias)}`);
      innerAggAliases.push(innerAlias);
    }

    const innerSql =
      `SELECT ${innerSelectParts.join(", ")} ` +
      `FROM ${tableExpr} WHERE ${whereSql} ` +
      `GROUP BY ${innerGroupParts.join(", ")}`;

    // Outer SELECT: pass through groupBy columns by their LOGICAL aliases
    // (inner already aliased them) and apply outer aggregator over the
    // inner-emitted unit_total alias.
    const outerSelectParts: string[] = groupBy.map(
      (g) => `${quoteIdent(g)} AS ${quoteIdent(g)}`
    );
    const aggs = p.aggregations ?? [];
    for (let idx = 0; idx < aggs.length; idx++) {
      const agg = aggs[idx]!;
      const innerAlias = innerAggAliases[idx]!;
      // The outer op consumes the inner alias (already a DOUBLE-typed
      // numeric); skip the redundant TRY_CAST that aggregationSqlExpr
      // wraps for raw row columns.
      const qInner = quoteIdent(innerAlias);
      let outerExpr: string;
      switch (agg.operation) {
        case "sum":
          outerExpr = `SUM(${qInner})`;
          break;
        case "mean":
        case "avg":
          outerExpr = `AVG(${qInner})`;
          break;
        case "min":
          outerExpr = `MIN(${qInner})`;
          break;
        case "max":
          outerExpr = `MAX(${qInner})`;
          break;
        case "count":
          // COUNT across buckets — counts how many distinct (groupBy,
          // perDimension) buckets the metric appears in.
          outerExpr = `COUNT(${qInner})`;
          break;
        default:
          // median / percent_change / countIf / sumIf already rejected
          // upstream by `canExecuteQueryPlanOnDuckDb` and the schema
          // superRefine — return null on this defensive path.
          return null;
      }
      const alias = outputAliasForAgg(
        agg.column,
        agg.operation,
        agg.alias,
        agg.perDimension
      );
      outerSelectParts.push(`${outerExpr} AS ${quoteIdent(alias)}`);
    }

    const outerGroupParts = groupBy.map((g) => quoteIdent(g));

    sql = `SELECT ${outerSelectParts.join(", ")} FROM (${innerSql}) sub`;
    if (outerGroupParts.length) {
      sql += ` GROUP BY ${outerGroupParts.join(", ")}`;
    }
  } else {
    sql = `SELECT ${selectParts.join(", ")} FROM ${tableExpr} WHERE ${whereSql}`;
    if (groupParts.length) {
      sql += ` GROUP BY ${groupParts.join(", ")}`;
    }
  }

  // Wave QL7 · Post-aggregation computed columns. Wrap the GROUP BY result
  // in an outer SELECT that evaluates each `{alias, expression}` against
  // the aggregation aliases. Lets the planner emit ratio shapes like
  // `SUM(metric) / COUNT(DISTINCT denom)` as one query. The expression
  // mini-language is validated upstream — only `+ - * / ( )`, numeric
  // literals, and aggregation alias identifiers — so direct interpolation
  // into SQL is safe (no SQL injection vector).
  const computedAggs = (p as QueryPlanBody).computedAggregations;
  if (Array.isArray(computedAggs) && computedAggs.length > 0) {
    const aggAliases = new Set<string>();
    for (const agg of p.aggregations ?? []) {
      aggAliases.add(
        outputAliasForAgg(agg.column, agg.operation, agg.alias, agg.perDimension)
      );
    }
    for (const g of groupBy) aggAliases.add(g);
    const computedParts: string[] = [];
    for (const c of computedAggs) {
      const parsed = parseComputedAggregationExpression(c.expression);
      if (!parsed.ok) {
        throw new Error(
          `computedAggregations[${c.alias}]: ${parsed.error}`
        );
      }
      for (const id of parsed.aliasesReferenced) {
        if (!aggAliases.has(id)) {
          throw new Error(
            `computedAggregations[${c.alias}]: identifier '${id}' is not an existing aggregation alias`
          );
        }
      }
      // Cast each alias to DOUBLE in the expression substitution so integer
      // division doesn't silently truncate (e.g. SUM/COUNT_DISTINCT of
      // integers). Substitute each identifier with `TRY_CAST("alias" AS DOUBLE)`.
      const subbed = c.expression.replace(
        /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
        (id) => `TRY_CAST(${quoteIdent(id)} AS DOUBLE)`
      );
      computedParts.push(`(${subbed}) AS ${quoteIdent(c.alias)}`);
    }
    sql = `SELECT *, ${computedParts.join(", ")} FROM (${sql}) ql7_computed`;
  }

  const sortParts: string[] = [];
  const allowedSort = new Set<string>(groupBy);
  if (!isNestedPlan && shouldHideIsoFromResults && periodIsoColumn) {
    allowedSort.add(periodIsoColumn);
  }
  for (const agg of p.aggregations ?? []) {
    const alias = outputAliasForAgg(
      agg.column,
      agg.operation,
      agg.alias,
      agg.perDimension
    );
    allowedSort.add(alias);
  }
  // Wave QL7 · Allow sort against computed-aggregation aliases too.
  for (const c of computedAggs ?? []) {
    allowedSort.add(c.alias);
  }
  // WPF3 · Rewrite explicit Period sorts to PeriodIso so ordering is
  // chronological ("Q1 23" < "Q2 23" < "Q1 24") instead of lexicographic.
  const sortRemap = (col: string): string =>
    shouldHideIsoFromResults && periodColumn && periodIsoColumn && col === periodColumn
      ? periodIsoColumn
      : col;
  let explicitSortHandlesPeriod = false;
  for (const s of p.sort ?? []) {
    if (!allowedSort.has(s.column)) continue;
    if (groupedByPeriod && periodColumn && s.column === periodColumn) {
      explicitSortHandlesPeriod = true;
    }
    const remapped = sortRemap(s.column);
    sortParts.push(`${quoteIdent(remapped)} ${s.direction.toUpperCase() === "DESC" ? "DESC" : "ASC"}`);
  }
  // WPF3 · Default chronological order for Period group-bys when the planner
  // didn't supply an explicit sort referencing Period.
  if (
    shouldHideIsoFromResults &&
    periodIsoColumn &&
    !explicitSortHandlesPeriod
  ) {
    sortParts.push(`${quoteIdent(periodIsoColumn)} ASC`);
  }
  if (sortParts.length) {
    sql += ` ORDER BY ${sortParts.join(", ")}`;
  }
  if (p.limit != null && p.limit > 0) {
    sql += ` LIMIT ${Math.min(p.limit, 50_000)}`;
  }

  const countSql = `SELECT COUNT(*)::BIGINT AS cnt FROM ${tableExpr} WHERE ${whereSql}`;

  // PD1 · "Average daily X per Cluster" / "Total weekly Sales per Region"
  // reads better than the raw "mean(X)" shape for nested plans. Map common
  // outer-operation × perDimension-grain pairs into natural-language adverbs.
  const describeOuterOp = (op: string): string => {
    switch (op) {
      case "mean":
      case "avg":
        return "Average";
      case "sum":
        return "Total";
      case "min":
        return "Minimum";
      case "max":
        return "Maximum";
      case "count":
        return "Distinct-bucket count of";
      default:
        return op;
    }
  };
  // Try to extract a temporal-unit adverb from a `Day · …` / `Week · …` /
  // `Month · …` / `Quarter · …` / `Year · …` perDimension prefix.
  const perDimAdverb = (perDim: string): string | null => {
    const m = perDim.match(/^(Day|Week|Month|Quarter|Year)\b/i);
    if (!m) return null;
    const grain = m[1]!.toLowerCase();
    switch (grain) {
      case "day":
        return "daily";
      case "week":
        return "weekly";
      case "month":
        return "monthly";
      case "quarter":
        return "quarterly";
      case "year":
        return "yearly";
      default:
        return null;
    }
  };

  const aggDesc = (() => {
    const aggs = p.aggregations ?? [];
    if (aggs.length > 0 && aggs.every((a) => a.perDimension)) {
      const phrase = aggs
        .map((a) => {
          const adverb = perDimAdverb(a.perDimension!);
          const noun = adverb
            ? `${adverb} ${a.column}`
            : `${a.column} per ${a.perDimension}`;
          return `${describeOuterOp(a.operation)} ${noun}`;
        })
        .join(", ");
      return groupBy.length
        ? `${phrase} by ${groupBy.join(", ")}`
        : phrase;
    }
    return groupBy.length
      ? `Grouped by ${groupBy.join(", ")} with ${aggs.map((a) => `${a.operation}(${a.column})`).join(", ")}`
      : `Aggregated ${aggs.map((a) => `${a.operation}(${a.column})`).join(", ")}`;
  })();

  return {
    aggregateSql: sql,
    countSql,
    descriptions: [...filterDesc, aggDesc],
    hiddenColumns:
      shouldHideIsoFromResults && periodIsoColumn ? [periodIsoColumn] : undefined,
  };
}

export type ExecuteQueryPlanOnDuckDbResult =
  | { ok: true; rows: Record<string, unknown>[]; inputRowCount: number; descriptions: string[] }
  | { ok: false; error: string };

export async function executeQueryPlanOnDuckDb(
  sessionId: string,
  plan: QueryPlanBody,
  summary: DataSummary,
  chat?: ChatDocument | null
): Promise<ExecuteQueryPlanOnDuckDbResult> {
  if (!isDuckDBAvailable()) {
    return { ok: false, error: "DuckDB not available" };
  }

  const storage = new ColumnarStorageService({ sessionId });
  try {
    await storage.initialize();
    if (chat) {
      try {
        await ensureAuthoritativeDataTable(storage, chat);
      } catch (e) {
        const msg = errorMessage(e);
        return { ok: false, error: msg };
      }
    }
    const descRows = await storage.executeQuery<{ column_name?: string }>(
      `DESCRIBE ${DATA_TABLE}`
    );
    const tableColumns = new Set(
      descRows.map((r) => String((r as { column_name?: string }).column_name ?? ""))
    );
    // Wave-FA2 · Resolve to `data_filtered` view when the session has an
    // active filter; canonical `data` otherwise. View is `CREATE OR REPLACE`d
    // idempotently per filter version.
    const tableName = chat
      ? await resolveSessionDataTable(storage, chat)
      : DATA_TABLE;
    const built = buildQueryPlanDuckdbSql(plan, { tableColumns, summary, tableName });
    if (!built) {
      return { ok: false, error: "Plan not supported on DuckDB executor" };
    }

    const cntRows = await storage.executeQuery<{ cnt: bigint | number }>(built.countSql);
    const rawCnt = cntRows[0]?.cnt ?? 0;
    const inputRowCount =
      typeof rawCnt === "bigint" ? Number(rawCnt) : Number(rawCnt);

    const rawRows = await storage.executeQuery<Record<string, unknown>>(built.aggregateSql);
    // WPF3 · Strip hidden columns (e.g. PeriodIso added for chronological
    // ORDER BY) so callers see only the planner-requested groupBy + aggregations.
    const rows =
      built.hiddenColumns && built.hiddenColumns.length > 0
        ? rawRows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(r)) {
              if (built.hiddenColumns!.includes(k)) continue;
              out[k] = r[k];
            }
            return out;
          })
        : rawRows;
    return {
      ok: true,
      rows,
      inputRowCount: Number.isFinite(inputRowCount) ? inputRowCount : 0,
      descriptions: built.descriptions,
    };
  } catch (e) {
    const msg = errorMessage(e);
    return { ok: false, error: msg };
  } finally {
    await storage.close();
  }
}
