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
import { clearRedundantDateAggregationForTemporalFacets } from "./queryPlanExecutor.js";
import { isIdColumn, getCountNameForIdColumn } from "./columnIdHeuristics.js";
import {
  buildDisplayToLegacyFacetMap,
  duckPhysicalColumnName,
  facetColumnInlineDuckDbExpr,
} from "./temporalFacetColumns.js";

const DATA_TABLE = "data";

function quoteIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

function escapeSqlStringLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

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

function buildWhereClause(
  plan: QueryPlanBody,
  physicalOf: (logical: string) => string
): { sql: string; descriptions: string[] } {
  const descriptions: string[] = [];
  const parts: string[] = [];
  for (const filter of plan.dimensionFilters ?? []) {
    if (!filter.column || !filter.values?.length) continue;
    const mode = filter.match || "exact";
    const physCol = physicalOf(filter.column);
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
      if (likeParts.length === 0) continue;
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

    parts.push(pred);
    const descVals = filter.values.join(", ");
    descriptions.push(
      filter.op === "in"
        ? `${filter.column} in [${descVals}] (${mode})`
        : `${filter.column} not in [${descVals}] (${mode})`
    );
  }
  return { sql: parts.length ? parts.join(" AND ") : "1=1", descriptions };
}

function aggregationSqlExpr(
  columnLogical: string,
  columnPhysical: string,
  operation: NonNullable<QueryPlanBody["aggregations"]>[0]["operation"]
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
    default:
      return "";
  }
}

function outputAliasForAgg(
  column: string,
  operation: NonNullable<QueryPlanBody["aggregations"]>[0]["operation"],
  alias?: string
): string {
  if (alias?.trim()) return alias.trim();
  if (operation === "count" && isIdColumn(column)) {
    return getCountNameForIdColumn(column);
  }
  return `${column}_${operation}`;
}

export function canExecuteQueryPlanOnDuckDb(plan: QueryPlanBody): boolean {
  const p = clearRedundantDateAggregationForTemporalFacets(plan);
  if (!p.aggregations?.length) return false;
  if (p.dateAggregationPeriod != null && p.dateAggregationPeriod !== undefined) {
    return false;
  }
  for (const a of p.aggregations) {
    if (a.operation === "median" || a.operation === "percent_change") return false;
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
    const inlineExpr =
      !materializedExists && ctx
        ? facetColumnInlineDuckDbExpr(g, ctx.tableColumns)
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

  for (const agg of p.aggregations ?? []) {
    const colPhys = physicalOf(agg.column);
    const expr = aggregationSqlExpr(agg.column, colPhys, agg.operation);
    if (!expr) return null;
    const alias = outputAliasForAgg(agg.column, agg.operation, agg.alias);
    selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
  }

  // WPF3 · Hidden ISO column: include in SELECT + GROUP BY so we can ORDER
  // BY it chronologically. Stripped from result rows below.
  if (shouldHideIsoFromResults && periodIsoColumn) {
    const qIso = quoteIdent(periodIsoColumn);
    selectParts.push(`${qIso} AS ${qIso}`);
    groupParts.push(qIso);
  }

  const tableExpr = quoteIdent(ctx?.tableName ?? DATA_TABLE);
  let sql = `SELECT ${selectParts.join(", ")} FROM ${tableExpr} WHERE ${whereSql}`;
  if (groupParts.length) {
    sql += ` GROUP BY ${groupParts.join(", ")}`;
  }

  const sortParts: string[] = [];
  const allowedSort = new Set<string>(groupBy);
  if (shouldHideIsoFromResults && periodIsoColumn) {
    allowedSort.add(periodIsoColumn);
  }
  for (const agg of p.aggregations ?? []) {
    const alias = outputAliasForAgg(agg.column, agg.operation, agg.alias);
    allowedSort.add(alias);
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

  const aggDesc =
    groupBy.length ?
      `Grouped by ${groupBy.join(", ")} with ${(p.aggregations ?? []).map((a) => `${a.operation}(${a.column})`).join(", ")}`
    : `Aggregated ${(p.aggregations ?? []).map((a) => `${a.operation}(${a.column})`).join(", ")}`;

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
        const msg = e instanceof Error ? e.message : String(e);
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
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  } finally {
    await storage.close();
  }
}
