import type { ChatDocument } from "../models/chat.model.js";
import {
  QueryPlan,
  QueryResult,
  QueryFilter,
  QueryAggregation,
} from "../shared/queryTypes.js";
import { loadDataForColumns } from "../utils/dataLoader.js";
import {
  buildDatasetProfile,
  buildMetadataOnlyResult,
} from "./queryPlanner.js";
import { executeParameterizedQuery } from "./snowflakeService.js";

interface ExecuteQueryPlanParams {
  chatDoc: ChatDocument;
  queryPlan: QueryPlan;
}

interface SnowflakeTableRef {
  database: string;
  schema: string;
  tableName: string;
}

function isSnowflakeSession(chatDoc: ChatDocument): chatDoc is ChatDocument & {
  sourceType: "snowflake";
  snowflakeSource: SnowflakeTableRef;
} {
  return (
    chatDoc.sourceType === "snowflake" &&
    !!chatDoc.snowflakeSource &&
    typeof chatDoc.snowflakeSource.database === "string" &&
    typeof chatDoc.snowflakeSource.schema === "string" &&
    typeof chatDoc.snowflakeSource.tableName === "string"
  );
}

function escapeIdentifier(name: string): string {
  const trimmed = (name || "").trim();
  const safe = trimmed.replace(/"/g, '""');
  return `"${safe}"`;
}

function buildSnowflakeSqlFromPlan(
  plan: QueryPlan,
  table: SnowflakeTableRef
): { sql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  // WHERE clause from filters
  for (const filter of plan.filters) {
    const col = escapeIdentifier(filter.column);
    switch (filter.operator) {
      case "=":
        conditions.push(`${col} = ?`);
        params.push(filter.value);
        break;
      case "!=":
        conditions.push(`${col} <> ?`);
        params.push(filter.value);
        break;
      case ">":
        conditions.push(`${col} > ?`);
        params.push(filter.value);
        break;
      case ">=":
        conditions.push(`${col} >= ?`);
        params.push(filter.value);
        break;
      case "<":
        conditions.push(`${col} < ?`);
        params.push(filter.value);
        break;
      case "<=":
        conditions.push(`${col} <= ?`);
        params.push(filter.value);
        break;
      case "contains": {
        conditions.push(`${col} ILIKE ?`);
        params.push(`%${filter.value}%`);
        break;
      }
      default:
        break;
    }
  }

  const tableSql = `${escapeIdentifier(table.database)}.${escapeIdentifier(
    table.schema
  )}.${escapeIdentifier(table.tableName)}`;

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const hasAggregations = plan.aggregations.length > 0;
  const hasGroupBy = plan.groupBy.length > 0;

  if (hasAggregations || hasGroupBy) {
    // Aggregated / grouped query
    const selectParts: string[] = [];
    const groupCols: string[] = [];
    const aggAliasMap = new Map<string, string>();

    for (const col of plan.groupBy) {
      const id = escapeIdentifier(col);
      selectParts.push(id);
      groupCols.push(id);
    }

    for (const agg of plan.aggregations) {
      const func =
        agg.type === "sum"
          ? "SUM"
          : agg.type === "avg"
          ? "AVG"
          : agg.type === "count"
          ? "COUNT"
          : agg.type === "min"
          ? "MIN"
          : "MAX";
      const colId = escapeIdentifier(agg.column);
      const alias =
        plan.aggregations.length === 1
          ? agg.column
          : `${agg.column}_${agg.type}`;
      const aliasId = escapeIdentifier(alias);
      aggAliasMap.set(agg.column, alias);
      selectParts.push(`${func}(${colId}) AS ${aliasId}`);
    }

    if (selectParts.length === 0) {
      // Fallback to simple row-level select if nothing is selected
      return buildRowLevelSnowflakeSql(plan, table);
    }

    let sql = `SELECT ${selectParts.join(", ")} FROM ${tableSql} ${whereSql}`;

    if (groupCols.length > 0) {
      sql += ` GROUP BY ${groupCols.join(", ")}`;
    }

    if (plan.sortBy) {
      const sortColumnAlias =
        aggAliasMap.get(plan.sortBy.column) ?? plan.sortBy.column;
      sql += ` ORDER BY ${escapeIdentifier(
        sortColumnAlias
      )} ${plan.sortBy.direction === "desc" ? "DESC" : "ASC"}`;
    }

    if (plan.limit && plan.limit > 0) {
      sql += ` LIMIT ${Math.max(1, Math.floor(plan.limit))}`;
    }

    return { sql, params };
  }

  // Pure row-level filter or lookup
  return buildRowLevelSnowflakeSql(plan, table, conditions, params);
}

function buildRowLevelSnowflakeSql(
  plan: QueryPlan,
  table: SnowflakeTableRef,
  prebuiltConditions?: string[],
  prebuiltParams?: any[]
): { sql: string; params: any[] } {
  const tableSql = `${escapeIdentifier(table.database)}.${escapeIdentifier(
    table.schema
  )}.${escapeIdentifier(table.tableName)}`;

  const conditions = prebuiltConditions ?? [];
  const params = prebuiltParams ?? [];

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let sql = `SELECT * FROM ${tableSql} ${whereSql}`;

  if (plan.sortBy) {
    sql += ` ORDER BY ${escapeIdentifier(
      plan.sortBy.column
    )} ${plan.sortBy.direction === "desc" ? "DESC" : "ASC"}`;
  }

  const limit =
    typeof plan.limit === "number" && plan.limit > 0
      ? Math.floor(plan.limit)
      : plan.action === "row_lookup"
      ? 100
      : 1000;
  sql += ` LIMIT ${limit}`;

  return { sql, params };
}

async function executeSnowflakePlan(
  chatDoc: ChatDocument,
  plan: QueryPlan
): Promise<QueryResult> {
  if (!isSnowflakeSession(chatDoc)) {
    throw new Error(
      "executeSnowflakePlan called for non-Snowflake session. This is a programming error."
    );
  }

  const { snowflakeSource } = chatDoc;
  const { sql, params } = buildSnowflakeSqlFromPlan(plan, snowflakeSource);

  const rows = await executeParameterizedQuery(sql, params);

  const metaColumns =
    rows.length > 0 ? Object.keys(rows[0]) : [...plan.groupBy];

  return {
    rows: rows.map((r) => {
      const out: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(r)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null
        ) {
          out[key] = value;
        } else if (value instanceof Date) {
          out[key] = value.toISOString();
        } else {
          out[key] = value == null ? null : String(value);
        }
      }
      return out;
    }),
    meta: {
      rowCount: rows.length,
      columns: metaColumns,
      action: plan.action,
      groupBy: plan.groupBy.length ? plan.groupBy : undefined,
      sortBy: plan.sortBy,
      limit: plan.limit,
      diagnostics: [
        "Executed query plan directly against Snowflake table (no blob scan).",
      ],
    },
  };
}

function passesFilter(row: Record<string, any>, filter: QueryFilter): boolean {
  const value = row[filter.column];
  const cmp =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number(value.replace(/[,]/g, ""))
      : Number(value);

  switch (filter.operator) {
    case "=":
      return value === filter.value;
    case "!=":
      return value !== filter.value;
    case ">":
      return typeof filter.value === "number"
        ? cmp > filter.value
        : false;
    case ">=":
      return typeof filter.value === "number"
        ? cmp >= filter.value
        : false;
    case "<":
      return typeof filter.value === "number"
        ? cmp < filter.value
        : false;
    case "<=":
      return typeof filter.value === "number"
        ? cmp <= filter.value
        : false;
    case "contains": {
      const haystack = value == null ? "" : String(value).toLowerCase();
      const needle =
        filter.value == null ? "" : String(filter.value).toLowerCase();
      return haystack.includes(needle);
    }
    default:
      return true;
  }
}

interface AggregationState {
  sum?: number;
  count?: number;
  min?: number;
  max?: number;
}

function updateAggregationState(
  state: AggregationState,
  agg: QueryAggregation,
  rawValue: any
) {
  const num =
    typeof rawValue === "number"
      ? rawValue
      : Number(String(rawValue).replace(/[,]/g, ""));
  if (Number.isNaN(num)) {
    return;
  }

  switch (agg.type) {
    case "sum":
    case "avg":
      state.sum = (state.sum ?? 0) + num;
      state.count = (state.count ?? 0) + 1;
      break;
    case "count":
      state.count = (state.count ?? 0) + 1;
      break;
    case "min":
      state.min = state.min == null ? num : Math.min(state.min, num);
      break;
    case "max":
      state.max = state.max == null ? num : Math.max(state.max, num);
      break;
  }
}

function finalizeAggregationValue(state: AggregationState, agg: QueryAggregation): number | null {
  switch (agg.type) {
    case "sum":
      return state.sum ?? 0;
    case "avg":
      if (!state.sum || !state.count) return null;
      return state.sum / state.count;
    case "count":
      return state.count ?? 0;
    case "min":
      return state.min ?? null;
    case "max":
      return state.max ?? null;
    default:
      return null;
  }
}

function aggregateRowsInMemory(
  plan: QueryPlan,
  rows: Record<string, any>[]
): QueryResult {
  // If no aggregations and no groupBy, this is a pure filter / lookup
  if (plan.aggregations.length === 0 && plan.groupBy.length === 0) {
    return filterAndProjectRows(plan, rows);
  }

  const groupMap = new Map<
    string,
    { keyValues: Record<string, any>; aggs: AggregationState[] }
  >();

  for (const row of rows) {
    // Apply filters first
    if (!plan.filters.every((f) => passesFilter(row, f))) continue;

    const keyParts = plan.groupBy.map((col) => String(row[col] ?? ""));
    const key = keyParts.join("||");

    if (!groupMap.has(key)) {
      const keyValues: Record<string, any> = {};
      for (const col of plan.groupBy) {
        keyValues[col] = row[col];
      }
      groupMap.set(key, {
        keyValues,
        aggs: plan.aggregations.map(() => ({} as AggregationState)),
      });
    }

    const entry = groupMap.get(key)!;
    plan.aggregations.forEach((agg, idx) => {
      updateAggregationState(entry.aggs[idx], agg, row[agg.column]);
    });
  }

  const resultRows: Array<Record<string, string | number | boolean | null>> =
    [];

  for (const { keyValues, aggs } of groupMap.values()) {
    const out: Record<string, string | number | boolean | null> = {};
    for (const col of plan.groupBy) {
      const value = keyValues[col];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        out[col] = value;
      } else if (value instanceof Date) {
        out[col] = value.toISOString();
      } else {
        out[col] = value == null ? null : String(value);
      }
    }

    plan.aggregations.forEach((agg, idx) => {
      const alias =
        plan.aggregations.length === 1
          ? agg.column
          : `${agg.column}_${agg.type}`;
      const val = finalizeAggregationValue(aggs[idx], agg);
      out[alias] = val;
    });

    resultRows.push(out);
  }

  // Sorting & limiting
  if (plan.sortBy) {
    const { column, direction } = plan.sortBy;
    resultRows.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (av === bv) return 0;
      const dir = direction === "desc" ? -1 : 1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const limitedRows =
    plan.limit && plan.limit > 0
      ? resultRows.slice(0, Math.floor(plan.limit))
      : resultRows;

  const metaColumns =
    limitedRows.length > 0 ? Object.keys(limitedRows[0]) : [...plan.groupBy];

  return {
    rows: limitedRows,
    meta: {
      rowCount: limitedRows.length,
      columns: metaColumns,
      action: plan.action,
      groupBy: plan.groupBy.length ? plan.groupBy : undefined,
      sortBy: plan.sortBy,
      limit: plan.limit,
      diagnostics: [
        "Executed query plan in-memory over blob-backed dataset with streaming-style aggregation.",
      ],
    },
  };
}

function filterAndProjectRows(
  plan: QueryPlan,
  rows: Record<string, any>[]
): QueryResult {
  const filtered: Array<Record<string, string | number | boolean | null>> = [];

  for (const row of rows) {
    if (!plan.filters.every((f) => passesFilter(row, f))) continue;

    const out: Record<string, string | number | boolean | null> = {};
    const columnsToInclude = new Set<string>();
    plan.groupBy.forEach((c) => columnsToInclude.add(c));
    plan.filters.forEach((f) => columnsToInclude.add(f.column));
    if (plan.sortBy) columnsToInclude.add(plan.sortBy.column);

    const cols =
      columnsToInclude.size > 0 ? Array.from(columnsToInclude) : Object.keys(row);

    for (const col of cols) {
      const value = row[col];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        out[col] = value;
      } else if (value instanceof Date) {
        out[col] = value.toISOString();
      } else {
        out[col] = value == null ? null : String(value);
      }
    }

    filtered.push(out);
  }

  if (plan.sortBy) {
    const { column, direction } = plan.sortBy;
    filtered.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (av === bv) return 0;
      const dir = direction === "desc" ? -1 : 1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const limit =
    typeof plan.limit === "number" && plan.limit > 0
      ? Math.floor(plan.limit)
      : plan.action === "row_lookup"
      ? 100
      : 1000;

  const limitedRows = filtered.slice(0, limit);

  const metaColumns =
    limitedRows.length > 0 ? Object.keys(limitedRows[0]) : [];

  return {
    rows: limitedRows,
    meta: {
      rowCount: limitedRows.length,
      columns: metaColumns,
      action: plan.action,
      sortBy: plan.sortBy,
      limit,
      diagnostics: [
        "Executed row-level query over blob-backed dataset; raw rows limited for safety.",
      ],
    },
  };
}

async function executeCsvBlobPlan(
  chatDoc: ChatDocument,
  plan: QueryPlan
): Promise<QueryResult> {
  const requiredColumns = new Set<string>();
  plan.filters.forEach((f) => requiredColumns.add(f.column));
  plan.groupBy.forEach((g) => requiredColumns.add(g));
  plan.aggregations.forEach((a) => requiredColumns.add(a.column));
  if (plan.sortBy) requiredColumns.add(plan.sortBy.column);

  const requiredColumnsArray = Array.from(requiredColumns);

  const rows = await loadDataForColumns(
    chatDoc,
    requiredColumnsArray.length ? requiredColumnsArray : chatDoc.dataSummary.columns.map((c) => c.name)
  );

  return aggregateRowsInMemory(plan, rows);
}

/**
 * Execute a QueryPlan against the full dataset for a session.
 * - Snowflake sessions: push computation down to Snowflake.
 * - CSV/Excel uploads: load data from Azure Blob / columnar storage and aggregate in-memory.
 * - Metadata-only plans (requiresFullScan === false): answered from dataset profile without scanning rows.
 */
export async function executeQueryPlan(
  params: ExecuteQueryPlanParams
): Promise<QueryResult> {
  const { chatDoc, queryPlan } = params;

  const profile = buildDatasetProfile(chatDoc);

  // Metadata-only path: never touch raw rows
  if (queryPlan.requiresFullScan === false) {
    return buildMetadataOnlyResult(queryPlan, profile);
  }

  if (isSnowflakeSession(chatDoc)) {
    return executeSnowflakePlan(chatDoc, queryPlan);
  }

  // Default: CSV/Excel upload or non-Snowflake session
  return executeCsvBlobPlan(chatDoc, queryPlan);
}

