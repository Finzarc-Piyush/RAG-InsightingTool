// WGR2 · DuckDB SQL builder for LAG-based growth analysis.
//
// Emits parameterised SELECT statements that compute period-over-period
// growth (YoY/QoQ/MoM/WoW) using the DuckDB `LAG()` window function.
//
// Three modes:
//   "series"        — one row per (dimension?, period) with prior_value
//                     and growth_pct
//   "summary"       — one row per period (no dimension breakdown)
//   "rankByGrowth"  — one row per dimension value, latest-period growth
//                     descending, LIMIT topN; this is the
//                     "fastest growing market" path
//
// For wide-format-melted datasets, callers pass `periodIsoColumn`
// (typically "PeriodIso" — see WPF3 convention) as the canonical
// sortable period axis and the SQL ORDER BY uses it. For long-format
// datasets with raw timestamps, `dateColumn` is bucketed via
// `date_trunc(<grain>, dateColumn)` inside the CTE.
//
// All identifiers and string values flow through `quoteIdent` /
// `escapeSqlStringLiteral` (per CLAUDE.md FA1 convention — no
// hand-rolled escapes).

import { quoteIdent, escapeSqlStringLiteral } from "../pivotFilterSql.js";
import type { DimensionFilter } from "../../shared/queryTypes.js";
import type { GrowthGrain } from "./periodShift.js";

export type GrowthMode = "series" | "summary" | "rankByGrowth";

export type PeriodKind = "month" | "quarter" | "week" | "year";

export interface BuildGrowthSqlInput {
  tableName: string;
  metricColumn: string;
  dimensionColumn?: string;
  /** Raw timestamp / date column (used when periodIsoColumn is absent). */
  dateColumn?: string;
  /** Pre-bucketed canonical period column (preferred — wide-format PeriodIso, temporal facets). */
  periodIsoColumn?: string;
  grain: GrowthGrain;
  /**
   * Underlying period kind of the data (drives the LAG offset for YoY).
   *  - month  → YoY=12, MoM=1
   *  - quarter→ YoY=4,  QoQ=1
   *  - week   → YoY=52, WoW=1
   *  - year   → YoY=1
   * Inferred from grain when absent: yoy ⇒ year, qoq ⇒ quarter, mom ⇒ month, wow ⇒ week.
   */
  periodKind?: PeriodKind;
  mode: GrowthMode;
  /** rankByGrowth mode only; default 10, max 50. */
  topN?: number;
  /** Default "sum"; min/max/avg supported for completeness. */
  aggregation?: "sum" | "avg" | "min" | "max";
  dimensionFilters?: DimensionFilter[];
  /** When emitting ORDER BY, prefer DESC on growth (rank mode). Default ASC for series. */
}

export interface BuildGrowthSqlResult {
  sql: string;
  /** The LAG offset used (12 for YoY-monthly, 4 for YoY-quarterly, etc.). Useful for tests. */
  lagOffset: number;
  /** Column names returned by the SELECT, in order. */
  columns: string[];
}

function inferPeriodKind(input: BuildGrowthSqlInput): PeriodKind {
  if (input.periodKind) return input.periodKind;
  if (input.grain === "yoy") return "year";
  if (input.grain === "qoq") return "quarter";
  if (input.grain === "mom") return "month";
  return "week";
}

function lagOffsetFor(grain: GrowthGrain, kind: PeriodKind): number {
  if (grain === "qoq") return 1;
  if (grain === "mom") return 1;
  if (grain === "wow") return 1;
  // YoY varies by underlying kind
  if (kind === "month") return 12;
  if (kind === "quarter") return 4;
  if (kind === "week") return 52;
  return 1;
}

function dateTruncUnit(kind: PeriodKind): string {
  if (kind === "month") return "month";
  if (kind === "quarter") return "quarter";
  if (kind === "week") return "week";
  return "year";
}

function buildDimensionFilterWhereSql(
  filters: DimensionFilter[] | undefined
): string {
  if (!filters || filters.length === 0) return "";
  const parts: string[] = [];
  for (const f of filters) {
    if (!f.values || f.values.length === 0) continue;
    const colExpr =
      f.match === "case_insensitive"
        ? `LOWER(COALESCE(CAST(${quoteIdent(f.column)} AS VARCHAR), ''))`
        : `COALESCE(CAST(${quoteIdent(f.column)} AS VARCHAR), '')`;
    const list = f.values
      .map((v) =>
        f.match === "case_insensitive"
          ? escapeSqlStringLiteral(String(v).toLowerCase())
          : escapeSqlStringLiteral(String(v))
      )
      .join(", ");
    if (f.op === "not_in") {
      parts.push(`${colExpr} NOT IN (${list})`);
    } else {
      parts.push(`${colExpr} IN (${list})`);
    }
  }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

function aggExpr(metric: string, mode: BuildGrowthSqlInput["aggregation"]): string {
  const op = (mode ?? "sum").toUpperCase();
  // Coerce strings to DOUBLE before aggregation; NULL on bad rows so the
  // aggregator skips them. Mirrors the pattern in buildActiveFilterSql.
  return `${op}(TRY_CAST(${quoteIdent(metric)} AS DOUBLE))`;
}

function buildPeriodExpr(input: BuildGrowthSqlInput, kind: PeriodKind): string {
  if (input.periodIsoColumn) return quoteIdent(input.periodIsoColumn);
  if (input.dateColumn) {
    return `CAST(date_trunc('${dateTruncUnit(kind)}', TRY_CAST(${quoteIdent(
      input.dateColumn
    )} AS TIMESTAMP)) AS VARCHAR)`;
  }
  throw new Error("buildGrowthSql: either periodIsoColumn or dateColumn must be provided");
}

/**
 * Build the SQL for a growth query. Pure function — deterministic,
 * unit-tested independently of any DuckDB connection.
 */
export function buildGrowthSql(input: BuildGrowthSqlInput): BuildGrowthSqlResult {
  const kind = inferPeriodKind(input);
  const lag = lagOffsetFor(input.grain, kind);
  const periodExpr = buildPeriodExpr(input, kind);
  const where = buildDimensionFilterWhereSql(input.dimensionFilters);
  const tbl = quoteIdent(input.tableName);
  const agg = aggExpr(input.metricColumn, input.aggregation);

  const dim = input.dimensionColumn ? quoteIdent(input.dimensionColumn) : null;

  if (input.mode === "summary") {
    // No dimension; aggregate to one row per period, then LAG over period.
    const sql = `
WITH bucketed AS (
  SELECT
    ${periodExpr} AS period,
    ${agg} AS value
  FROM ${tbl}
  ${where}
  GROUP BY ${periodExpr}
)
SELECT
  period,
  value,
  LAG(value, ${lag}) OVER (ORDER BY period ASC) AS prior_value,
  CASE
    WHEN LAG(value, ${lag}) OVER (ORDER BY period ASC) IS NULL THEN NULL
    WHEN LAG(value, ${lag}) OVER (ORDER BY period ASC) = 0 THEN NULL
    ELSE (value - LAG(value, ${lag}) OVER (ORDER BY period ASC))
         / LAG(value, ${lag}) OVER (ORDER BY period ASC)
  END AS growth_pct,
  value - LAG(value, ${lag}) OVER (ORDER BY period ASC) AS growth_abs
FROM bucketed
ORDER BY period ASC
`.trim();
    return {
      sql,
      lagOffset: lag,
      columns: ["period", "value", "prior_value", "growth_pct", "growth_abs"],
    };
  }

  if (input.mode === "series") {
    if (!dim) {
      // No dimension provided → behaves like summary.
      return buildGrowthSql({ ...input, mode: "summary" });
    }
    const sql = `
WITH bucketed AS (
  SELECT
    ${dim} AS dimension,
    ${periodExpr} AS period,
    ${agg} AS value
  FROM ${tbl}
  ${where}
  GROUP BY ${dim}, ${periodExpr}
)
SELECT
  dimension,
  period,
  value,
  LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC) AS prior_value,
  CASE
    WHEN LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC) IS NULL THEN NULL
    WHEN LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC) = 0 THEN NULL
    ELSE (value - LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC))
         / LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC)
  END AS growth_pct,
  value - LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC) AS growth_abs
FROM bucketed
ORDER BY dimension ASC, period ASC
`.trim();
    return {
      sql,
      lagOffset: lag,
      columns: ["dimension", "period", "value", "prior_value", "growth_pct", "growth_abs"],
    };
  }

  // rankByGrowth
  if (!dim) {
    throw new Error("buildGrowthSql: rankByGrowth mode requires dimensionColumn");
  }
  const topN = Math.max(2, Math.min(50, input.topN ?? 10));
  const sql = `
WITH bucketed AS (
  SELECT
    ${dim} AS dimension,
    ${periodExpr} AS period,
    ${agg} AS value
  FROM ${tbl}
  ${where}
  GROUP BY ${dim}, ${periodExpr}
),
with_lag AS (
  SELECT
    dimension,
    period,
    value,
    LAG(value, ${lag}) OVER (PARTITION BY dimension ORDER BY period ASC) AS prior_value
  FROM bucketed
),
ranked AS (
  SELECT
    dimension,
    period,
    value,
    prior_value,
    ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY period DESC) AS rn
  FROM with_lag
  WHERE prior_value IS NOT NULL AND prior_value <> 0
)
SELECT
  dimension,
  period,
  value,
  prior_value,
  (value - prior_value) / prior_value AS growth_pct,
  (value - prior_value) AS growth_abs
FROM ranked
WHERE rn = 1
ORDER BY growth_pct DESC NULLS LAST
LIMIT ${topN}
`.trim();
  return {
    sql,
    lagOffset: lag,
    columns: ["dimension", "period", "value", "prior_value", "growth_pct", "growth_abs"],
  };
}
