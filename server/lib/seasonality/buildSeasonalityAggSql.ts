// WSE2 · DuckDB SQL builder for seasonality aggregation.
//
// Emits a parameterised SELECT that aggregates `valueColumn` by
// `(year, position[, dimension])` so the WSE1 helpers can compute
// month-of-year / quarter-of-year indices and peak consistency.
//
// Two execution paths chosen by which date axis the caller supplies:
//   - Wide-format `periodIsoColumn` (e.g. PeriodIso = "2024-03"):
//     SUBSTR-based extraction. The wide-format vocabulary at
//     `periodVocabulary.ts` emits a deterministic ISO label format so
//     this is safe.
//   - Raw `dateColumn` (e.g. Order Date timestamps):
//     DuckDB MONTH() / QUARTER() / YEAR() functions, mirroring the
//     `temporalFacetColumns.ts` convention (NOT EXTRACT()).
//
// All identifiers and literals flow through `quoteIdent` /
// `escapeSqlStringLiteral` (FA1 convention — no hand-rolled escapes).

import { quoteIdent, escapeSqlStringLiteral } from "../pivotFilterSql.js";
import type { DimensionFilter } from "../../shared/queryTypes.js";
import type { SeasonalityGrain } from "./computeSeasonality.js";

export interface BuildSeasonalityAggSqlInput {
  tableName: string;
  valueColumn: string;
  /** Raw timestamp / date column. Used when periodIsoColumn is absent. */
  dateColumn?: string;
  /** Pre-bucketed canonical period column (preferred — wide-format PeriodIso). */
  periodIsoColumn?: string;
  grain: SeasonalityGrain;
  dimensionColumn?: string;
  aggregation?: "sum" | "avg" | "min" | "max";
  dimensionFilters?: DimensionFilter[];
}

export interface BuildSeasonalityAggSqlResult {
  sql: string;
  /** Output column names, in order. */
  columns: string[];
}

function aggExpr(metric: string, mode: BuildSeasonalityAggSqlInput["aggregation"]): string {
  const op = (mode ?? "sum").toUpperCase();
  return `${op}(TRY_CAST(${quoteIdent(metric)} AS DOUBLE))`;
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
    if (f.op === "not_in") parts.push(`${colExpr} NOT IN (${list})`);
    else parts.push(`${colExpr} IN (${list})`);
  }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

/**
 * Year + position extraction expressions.
 *  - PeriodIso path: SUBSTR. PeriodIso for monthly is "YYYY-MM" so the year
 *    is positions 1..4 and the month is positions 6..7. PeriodIso for
 *    quarterly is "YYYY-Qn" → year same; quarter is the digit at position 7.
 *  - Raw-date path: YEAR() + MONTH() / QUARTER().
 */
function yearAndPositionExprs(
  input: BuildSeasonalityAggSqlInput
): { yearExpr: string; positionExpr: string } {
  if (input.periodIsoColumn) {
    const ident = quoteIdent(input.periodIsoColumn);
    const yearExpr = `CAST(SUBSTR(${ident}, 1, 4) AS INTEGER)`;
    if (input.grain === "month") {
      // SUBSTR(PeriodIso, 6, 2) = "MM" digits.
      return {
        yearExpr,
        positionExpr: `CAST(SUBSTR(${ident}, 6, 2) AS INTEGER)`,
      };
    }
    // grain === "quarter": SUBSTR(PeriodIso, 7, 1) = "1".."4" (the digit
    // after "Q"). Defensive: only matches "YYYY-Qn" — other shapes give
    // NULL on cast and get filtered by HAVING.
    return {
      yearExpr,
      positionExpr: `CAST(SUBSTR(${ident}, 7, 1) AS INTEGER)`,
    };
  }
  if (!input.dateColumn) {
    throw new Error(
      "buildSeasonalityAggSql: either periodIsoColumn or dateColumn must be supplied"
    );
  }
  const ts = `TRY_CAST(${quoteIdent(input.dateColumn)} AS TIMESTAMP)`;
  if (input.grain === "month") {
    return { yearExpr: `YEAR(${ts})`, positionExpr: `MONTH(${ts})` };
  }
  return { yearExpr: `YEAR(${ts})`, positionExpr: `QUARTER(${ts})` };
}

export function buildSeasonalityAggSql(
  input: BuildSeasonalityAggSqlInput
): BuildSeasonalityAggSqlResult {
  const { yearExpr, positionExpr } = yearAndPositionExprs(input);
  const where = buildDimensionFilterWhereSql(input.dimensionFilters);
  const tbl = quoteIdent(input.tableName);
  const agg = aggExpr(input.valueColumn, input.aggregation);
  const dim = input.dimensionColumn ? quoteIdent(input.dimensionColumn) : null;

  const positionsValid =
    input.grain === "month" ? "BETWEEN 1 AND 12" : "BETWEEN 1 AND 4";

  const selectParts = [
    `${yearExpr} AS year`,
    `${positionExpr} AS position`,
    ...(dim ? [`${dim} AS dimension`] : []),
    `${agg} AS value`,
  ];
  const groupByParts = [
    `year`,
    `position`,
    ...(dim ? [`dimension`] : []),
  ];

  const sql = `
WITH bucketed AS (
  SELECT
    ${selectParts.join(",\n    ")}
  FROM ${tbl}
  ${where}
  GROUP BY ${yearExpr}, ${positionExpr}${dim ? `, ${dim}` : ""}
)
SELECT *
FROM bucketed
WHERE year IS NOT NULL
  AND position IS NOT NULL
  AND position ${positionsValid}
ORDER BY year ASC, position ASC${dim ? `, dimension ASC` : ""}
`.trim();

  return {
    sql,
    columns: dim
      ? ["year", "position", "dimension", "value"]
      : ["year", "position", "value"],
  };
}
