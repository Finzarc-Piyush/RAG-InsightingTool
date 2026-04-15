/**
 * DuckDB Plan Executor
 * Runs ExecutionPlan steps (filter, group_by, aggregate, sort) directly in DuckDB
 * to avoid loading full data into memory for analytical/info-seeking chat.
 */

import type { ChatDocument } from '../models/chat.model.js';
import { ColumnarStorageService, isDuckDBAvailable } from './columnarStorage.js';
import { ensureAuthoritativeDataTable } from './ensureSessionDuckdbMaterialized.js';
import type { ExecutionPlan, ExecutionStep } from './analyticalQueryEngine.js';

const TABLE_NAME = 'data';

/** DuckDB aggregate names allowed in generated SQL (LLM plans must not inject arbitrary SQL). */
const ALLOWED_AGG_FUNCTIONS = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'median',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'var_pop',
  'var_samp',
  'variance',
]);

function normalizeAggFunction(raw: string | undefined): string {
  const s = (raw || 'sum').toLowerCase();
  if (s === 'mean') return 'avg';
  if (!ALLOWED_AGG_FUNCTIONS.has(s)) return 'sum';
  return s;
}

function escapeCol(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function escapeVal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && !isNaN(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build a single SQL query from an execution plan (filter, group_by, aggregate, sort).
 * Returns null if the plan contains unsupported steps (pivot, calculate, select, etc.).
 */
export function buildSqlFromPlan(plan: ExecutionPlan): string | null {
  const steps = plan.steps || [];
  if (steps.length === 0) return `SELECT * FROM ${TABLE_NAME}`;

  const unsupported = ['pivot', 'join', 'calculate', 'select'];
  for (const step of steps) {
    if (unsupported.includes(step.operation)) return null;
  }

  let currentFrom = TABLE_NAME;
  let selectList = '*';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const nextStep = steps[i + 1];
    const isGroupByBeforeAggregate =
      step.operation === 'group_by' &&
      nextStep?.operation === 'aggregate';

    if (step.operation === 'filter') {
      const { column, operator, value } = step.parameters || {};
      if (!column) continue;
      const col = escapeCol(column);
      let cond: string;
      switch (operator) {
        case '>':
        case '>=':
        case '<':
        case '<=':
          cond = `${col} ${operator} ${escapeVal(value)}`;
          break;
        case '=':
        case '==':
          cond = `TRIM(CAST(${col} AS VARCHAR)) = TRIM(CAST(${escapeVal(value)} AS VARCHAR))`;
          break;
        case '!=':
          cond = `TRIM(CAST(${col} AS VARCHAR)) != TRIM(CAST(${escapeVal(value)} AS VARCHAR))`;
          break;
        case 'contains':
          cond = `LOWER(CAST(${col} AS VARCHAR)) LIKE '%' || LOWER(${escapeVal(value)}) || '%'`;
          break;
        case 'starts_with':
          cond = `LOWER(CAST(${col} AS VARCHAR)) LIKE LOWER(${escapeVal(value)}) || '%'`;
          break;
        case 'ends_with':
          cond = `LOWER(CAST(${col} AS VARCHAR)) LIKE '%' || LOWER(${escapeVal(value)})`;
          break;
        default:
          continue;
      }
      currentFrom = `(SELECT * FROM ${currentFrom} WHERE ${cond})`;
      continue;
    }

    if (isGroupByBeforeAggregate && nextStep) {
      const groupStep = step;
      const aggStep = nextStep;
      const groupByCol = groupStep.parameters?.group_by_column || groupStep.parameters?.columns?.[0];
      const additionalGroup = groupStep.parameters?.additional_group_by as string[] | undefined;
      const groupCols = groupByCol
        ? [groupByCol, ...(additionalGroup || [])].filter(Boolean)
        : [];
      const aggCol = aggStep.parameters?.agg_column;
      const aggCols = (aggStep.parameters?.agg_columns as string[]) || (aggCol ? [aggCol] : []);
      const aggFunc = (aggStep.parameters?.agg_function as string) || 'sum';

      if (groupCols.length === 0 || aggCols.length === 0) {
        i++;
        continue;
      }

      const groupColsEsc = groupCols.map(escapeCol).join(', ');
      const aggExprs = aggCols.map((c) => {
        const esc = escapeCol(c);
        const fn = normalizeAggFunction(aggFunc);
        return `${fn}(${esc}) AS ${esc.replace(/"/g, '_')}_${fn}`;
      });
      selectList = `${groupColsEsc}, ${aggExprs.join(', ')}`;
      currentFrom = `(SELECT ${selectList} FROM ${currentFrom} GROUP BY ${groupColsEsc})`;
      i++;
      continue;
    }

    if (step.operation === 'group_by' && nextStep?.operation !== 'aggregate') {
      const groupByCol = step.parameters?.group_by_column || step.parameters?.columns?.[0];
      const additionalGroup = (step.parameters?.additional_group_by as string[]) || [];
      const groupCols = [groupByCol, ...additionalGroup].filter(Boolean);
      if (groupCols.length > 0) {
        const groupColsEsc = groupCols.map(escapeCol).join(', ');
        selectList = groupColsEsc;
        currentFrom = `(SELECT * FROM ${currentFrom} GROUP BY ${groupColsEsc})`;
      }
      continue;
    }

    if (step.operation === 'aggregate') {
      const groupByCol = step.parameters?.group_by_column;
      const aggCol = step.parameters?.agg_column;
      const aggCols = (step.parameters?.agg_columns as string[]) || (aggCol ? [aggCol] : []);
      const aggFunc = (step.parameters?.agg_function as string) || 'sum';
      if (!groupByCol || aggCols.length === 0) continue;
      const groupColsEsc = escapeCol(groupByCol);
      const aggExprs = aggCols.map((c) => {
        const esc = escapeCol(c);
        const fn = normalizeAggFunction(aggFunc);
        return `${fn}(${esc}) AS ${c.replace(/"/g, '_')}_${fn}`;
      });
      selectList = `${groupColsEsc}, ${aggExprs.join(', ')}`;
      currentFrom = `(SELECT ${selectList} FROM ${currentFrom} GROUP BY ${groupColsEsc})`;
      continue;
    }

    if (step.operation === 'sort') {
      const { column, direction = 'asc' } = step.parameters || {};
      if (!column) continue;
      const col = escapeCol(column);
      const dir = (direction as string).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      currentFrom = `(SELECT * FROM ${currentFrom} ORDER BY ${col} ${dir})`;
      continue;
    }
  }

  return `SELECT * FROM ${currentFrom}`;
}

/**
 * Execute an execution plan in DuckDB for the given session.
 * Returns result rows or null if DuckDB is unavailable or plan cannot be run in DuckDB.
 */
export async function executePlanInDuckDB(
  sessionId: string,
  plan: ExecutionPlan,
  chat?: ChatDocument | null
): Promise<{ success: boolean; data?: Record<string, any>[]; error?: string }> {
  if (!isDuckDBAvailable()) return { success: false, error: 'DuckDB not available' };

  const sql = buildSqlFromPlan(plan);
  if (!sql) return { success: false, error: 'Plan contains unsupported steps for DuckDB' };

  const storage = new ColumnarStorageService({ sessionId });
  try {
    await storage.initialize();
    if (chat) {
      try {
        await ensureAuthoritativeDataTable(storage, chat);
      } catch (ensureErr) {
        const msg = ensureErr instanceof Error ? ensureErr.message : String(ensureErr);
        return { success: false, error: msg };
      }
    }
    const rows = await storage.executeQuery<Record<string, any>>(sql);
    return { success: true, data: rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  } finally {
    await storage.close();
  }
}

/**
 * Get a small sample from DuckDB for column identification (no full load).
 */
export async function getSampleFromDuckDB(
  sessionId: string,
  limit: number = 5000,
  chat?: ChatDocument | null
): Promise<Record<string, any>[]> {
  if (!isDuckDBAvailable()) return [];

  const storage = new ColumnarStorageService({ sessionId });
  try {
    await storage.initialize();
    if (chat) {
      try {
        await ensureAuthoritativeDataTable(storage, chat);
      } catch {
        return [];
      }
    }
    return await storage.getSampleRows(limit);
  } catch {
    return [];
  } finally {
    await storage.close();
  }
}
