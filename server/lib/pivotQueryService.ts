import { ColumnarStorageService } from "./columnarStorage.js";
import { metadataService } from "./metadataService.js";
import {
  pivotQueryRequestSchema,
  pivotQueryResponseSchema,
  type PivotQueryRequest,
  type PivotQueryResponse,
  type PivotAggRow,
  type PivotModel,
  type PivotValueSpec,
  type PivotAgg,
  type PivotRowSort,
} from "../shared/schema.js";
import { pivotCache, stableHashJson } from "./pivotCache.js";

const pivotWarmupStarted = new Set<string>();

async function warmupPivotForSession(sessionId: string, dataVersion: number | string) {
  // Tests should remain deterministic and fast; skip background warmup under node test runs.
  if (process.argv.includes("--test")) return;

  const warmupKey = `${sessionId}_${dataVersion}`;
  if (pivotWarmupStarted.has(warmupKey)) return;
  pivotWarmupStarted.add(warmupKey);

  try {
    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();

    try {
      const metadata = await storage.computeMetadata();
      const sampleRows = await storage.getSampleRows(50);
      const summary = metadataService.convertToDataSummary(metadata, sampleRows);

      // Pick a reasonable default pivot:
      // - rows: first non-numeric column
      // - values: first numeric column (sum)
      const numericField = summary.numericColumns[0];
      const rowField =
        summary.columns.find((c) => c.name !== numericField && c.type !== "number")?.name ??
        summary.columns.find((c) => c.name !== numericField)?.name;

      if (!rowField || !numericField) return;

      const warmupRequest: PivotQueryRequest = {
        rowFields: [rowField],
        colFields: [],
        filterFields: [],
        valueSpecs: [
          {
            id: `meas_${numericField}`,
            field: numericField,
            agg: "sum",
          },
        ],
      };

      // Fire-and-forget: populate pivotCache for instant first pivot UX.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      await executePivotQuery(sessionId, warmupRequest, { dataVersion });
    } finally {
      await storage.close();
    }
  } catch (error) {
    // Best-effort: never fail the user-facing pivot request.
    console.warn("Pivot warmup failed (non-fatal):", error);
  }
}

function quoteIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

function escapeSqlStringLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function localeNumericSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Client-aligned numeric parsing (see `client/src/lib/formatAnalysisNumber.ts`).
 */
/** Stable string key for pivot grouping (avoids `[object Object]` from plain objects). */
function pivotDimensionStringKey(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number")
    return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === "object") {
    try {
      const o = raw as Record<string, unknown>;
      return JSON.stringify(raw, Object.keys(o).sort());
    } catch {
      return "[unserializable]";
    }
  }
  return String(raw);
}

function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "null") return null;

  const isParenNeg = raw.startsWith("(") && raw.endsWith(")");

  const cleaned = raw
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/[$€£¥₹]/g, "")
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/\s+/g, "");

  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -Math.abs(num) : num;
}

function applyAgg(
  rows: Record<string, unknown>[],
  spec: PivotValueSpec
): number {
  if (spec.agg === "count") {
    return rows.length;
  }

  const nums: number[] = [];
  for (const r of rows) {
    const n = parseNumericCell(r[spec.field]);
    if (n !== null) nums.push(n);
  }

  if (nums.length === 0) return 0;

  switch (spec.agg) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "mean":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    default:
      return 0;
  }
}

function collectColKeys(
  rows: Record<string, unknown>[],
  colField: string
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    set.add(pivotDimensionStringKey(r[colField]));
  }
  return [...set].sort(compareTemporalOrLocale);
}

function aggregatePivot(
  rows: Record<string, unknown>[],
  valueSpecs: PivotValueSpec[],
  colField: string | null,
  colKeys: string[]
): PivotAggRow {
  if (!colField) {
    const flatValues: Record<string, number> = {};
    for (const spec of valueSpecs) {
      flatValues[spec.id] = applyAgg(rows, spec);
    }
    return { flatValues, matrixValues: null };
  }

  const matrixValues: Record<string, Record<string, number>> = {};
  for (const ck of colKeys) {
    matrixValues[ck] = {};
    const slice = rows.filter((r) => pivotDimensionStringKey(r[colField]) === ck);
    for (const spec of valueSpecs) {
      matrixValues[ck][spec.id] = applyAgg(slice, spec);
    }
  }
  return { flatValues: null, matrixValues };
}

function groupByField(
  rows: Record<string, unknown>[],
  field: string
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = pivotDimensionStringKey(r[field]);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

function isoWeekStartUtc(isoYear: number, isoWeek: number): number {
  // ISO week starts on Monday. ISO week 1 is the week containing Jan 4th.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Sunday => 7
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
  const mondayTarget = new Date(mondayWeek1);
  mondayTarget.setUTCDate(mondayWeek1.getUTCDate() + (isoWeek - 1) * 7);
  return mondayTarget.getTime();
}

function parseTemporalFacetKeyForSort(key: string): number | null {
  const s = String(key ?? "").trim();
  if (!s) return null;

  let m: RegExpMatchArray | null;

  // Year: YYYY
  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return Date.UTC(year, 0, 1);
  }

  // Month: YYYY-MM
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return Date.UTC(year, month - 1, 1);
  }

  // Quarter: YYYY-Qn
  m = s.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const year = Number(m[1]);
    const q = Number(m[2]);
    const month = (q - 1) * 3;
    return Date.UTC(year, month, 1);
  }

  // Half-year: YYYY-Hn
  m = s.match(/^(\d{4})-H([1-2])$/);
  if (m) {
    const year = Number(m[1]);
    const h = Number(m[2]);
    const month = (h - 1) * 6;
    return Date.UTC(year, month, 1);
  }

  // ISO week: YYYY-Www
  m = s.match(/^(\d{4})-W(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const wk = Number(m[2]);
    if (wk >= 1 && wk <= 53) return isoWeekStartUtc(year, wk);
  }

  // Day: YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(year, month - 1, day);
    }
  }

  const isoTry = Date.parse(s);
  if (!Number.isNaN(isoTry)) return isoTry;

  return null;
}

function compareTemporalOrLocale(a: string, b: string): number {
  const ta = parseTemporalFacetKeyForSort(a);
  const tb = parseTemporalFacetKeyForSort(b);
  if (ta != null && tb != null) return ta - tb;
  if (ta != null) return -1;
  if (tb != null) return 1;
  return localeNumericSort(a, b);
}

function sortedKeys(keys: string[]): string[] {
  return [...keys].sort(compareTemporalOrLocale);
}

function buildLevel(
  rows: Record<string, unknown>[],
  rowFields: string[],
  depth: number,
  pathPrefix: string[],
  colField: string | null,
  colKeys: string[],
  valueSpecs: PivotValueSpec[],
  rowSort?: PivotRowSort
): { type: "leaf"; depth: number; label: string; pathKey: string; values: PivotAggRow }[] | any[] {
  if (rowFields.length === 0) return [];
  const field = rowFields[depth];
  const isLast = depth === rowFields.length - 1;

  const groups = groupByField(rows, field);
  let keys = sortedKeys([...groups.keys()]);

  if (rowSort?.primary === "rowLabel") {
    keys = [...groups.keys()].sort((a, b) => {
      const c = compareTemporalOrLocale(a, b);
      return rowSort.direction === "desc" ? -c : c;
    });
  } else if (rowSort?.byValueSpecId) {
    const chosen = valueSpecs.find((v) => v.id === rowSort.byValueSpecId);
    if (chosen) {
      keys = [...groups.keys()].sort((a, b) => {
        const subA = groups.get(a)!;
        const subB = groups.get(b)!;
        const totalA = applyAgg(subA, chosen);
        const totalB = applyAgg(subB, chosen);

        if (totalA === totalB) {
          return compareTemporalOrLocale(a, b);
        }

        const diff = totalA - totalB;
        return rowSort.direction === "desc" ? -diff : diff;
      });
    }
  }

  const out: any[] = [];
  for (const k of keys) {
    const sub = groups.get(k)!;
    const path = [...pathPrefix, k];
    const pathKey = path.join("\x1f");
    if (isLast) {
      out.push({
        type: "leaf",
        depth,
        label: k,
        pathKey,
        values: aggregatePivot(sub, valueSpecs, colField, colKeys),
      });
    } else {
      const children = buildLevel(
        sub,
        rowFields,
        depth + 1,
        path,
        colField,
        colKeys,
        valueSpecs,
        rowSort
      );
      const subtotal = aggregatePivot(sub, valueSpecs, colField, colKeys);
      out.push({
        type: "group",
        depth,
        label: k,
        pathKey,
        children,
        subtotal,
      });
    }
  }

  return out;
}

function buildPivotTree(
  rows: Record<string, unknown>[],
  rowFields: string[],
  colField: string | null,
  colKeys: string[],
  valueSpecs: PivotValueSpec[],
  rowSort?: PivotRowSort
): { nodes: any[]; grandTotal: PivotAggRow } {
  if (rowFields.length === 0) {
    const grandTotal = aggregatePivot(rows, valueSpecs, colField, colKeys);
    return { nodes: [], grandTotal };
  }

  const nodes = buildLevel(
    rows,
    rowFields,
    0,
    [],
    colField,
    colKeys,
    valueSpecs,
    rowSort
  );

  const grandTotal = aggregatePivot(rows, valueSpecs, colField, colKeys);
  return { nodes, grandTotal };
}

function buildWhereClause(
  request: PivotQueryRequest
): { whereSql: string; usedFilters: Record<string, string[]> } {
  const usedFilters: Record<string, string[]> = {};
  const filterSelections = request.filterSelections ?? {};
  const filterFields = request.filterFields ?? [];

  const parts: string[] = [];
  for (const f of filterFields) {
    const sel = filterSelections[f];
    if (sel === undefined) continue; // includes all values
    usedFilters[f] = sel;

    if (sel.length === 0) {
      return { whereSql: "1=0", usedFilters };
    }

    const colExpr = `COALESCE(CAST(${quoteIdent(f)} AS VARCHAR), '')`;
    const inList = sel.map((v) => escapeSqlStringLiteral(String(v))).join(", ");
    parts.push(`${colExpr} IN (${inList})`);
  }

  return { whereSql: parts.length ? parts.join(" AND ") : "1=1", usedFilters };
}

async function fetchFilteredRows(
  storage: ColumnarStorageService,
  request: PivotQueryRequest
): Promise<Record<string, unknown>[]> {
  const rowFields = request.rowFields;
  const colField = request.colFields[0] ?? null;

  const neededCols = new Set<string>([
    ...rowFields,
    ...(colField ? [colField] : []),
    ...request.valueSpecs.map((v) => v.field),
    ...(request.filterFields ?? []),
  ]);

  // If there are no fields, return empty.
  const selectCols = [...neededCols].filter(Boolean);
  if (selectCols.length === 0) return [];

  const { whereSql } = buildWhereClause(request);

  // Important: columns in dataApi are dynamic, so we must quote identifiers.
  const selectList = selectCols.map((c) => quoteIdent(c)).join(", ");
  const sql = `SELECT ${selectList} FROM data WHERE ${whereSql}`;
  return await storage.executeQuery<Record<string, unknown>>(sql);
}

export async function executePivotQuery(
  sessionId: string,
  rawBody: unknown,
  opts?: { dataVersion?: number | string }
): Promise<PivotQueryResponse> {
  const request = pivotQueryRequestSchema.parse(rawBody);

  const dataVersion = opts?.dataVersion ?? "na";
  const valueSpecsNormalized = request.valueSpecs.map((v) => ({
    field: v.field,
    agg: v.agg,
  }));

  const rowSortNormalized = request.rowSort
    ? (() => {
        const chosen = request.valueSpecs.find((v) => v.id === request.rowSort!.byValueSpecId);
        return {
          direction: request.rowSort!.direction,
          chosenField: chosen?.field ?? null,
          chosenAgg: chosen?.agg ?? null,
        };
      })()
    : null;

  const configHash = stableHashJson({
    rowFields: request.rowFields,
    colFields: request.colFields,
    filterFields: request.filterFields,
    filterSelections: request.filterSelections ?? null,
    valueSpecs: valueSpecsNormalized,
    rowSort: rowSortNormalized,
  });
  const cacheKey = `${sessionId}_${dataVersion}_${configHash}`;

  const cached = pivotCache.get<PivotQueryResponse>(cacheKey);
  if (cached) {
    const base = cached.value;
    return {
      ...base,
      meta: {
        ...(base.meta ?? {}),
        cached: true,
        cacheHit: true,
        durationMs: cached.ageMs,
      },
    };
  }

  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    await storage.assertTableExists('data');
    const start = Date.now();
    const filteredRows = await fetchFilteredRows(storage, request);

    const colField = request.colFields[0] ?? null;
    const colKeys = colField ? collectColKeys(filteredRows, colField) : [];

    const treeObj = buildPivotTree(
      filteredRows,
      request.rowFields,
      colField,
      colKeys,
      request.valueSpecs,
      request.rowSort
    );

    const model: PivotModel = {
      rowFields: request.rowFields,
      colField,
      columnFields: [...request.colFields],
      colKeys,
      valueSpecs: request.valueSpecs,
      tree: treeObj,
      columnFieldTruncated: request.colFields.length > 1,
    };

    const response: PivotQueryResponse = {
      model,
      meta: {
        source: "duckdb",
        rowCount: filteredRows.length,
        colKeyCount: colKeys.length,
        truncated: request.colFields.length > 1,
        cached: false,
        cacheHit: false,
        durationMs: Date.now() - start,
      },
    };

    const parsed = pivotQueryResponseSchema.parse(response);
    pivotCache.set(cacheKey, parsed);
    // Opportunistically warm a simple default pivot for this session.
    // This improves "first pivot" UX without blocking current request.
    void warmupPivotForSession(sessionId, dataVersion);
    return parsed;
  } finally {
    await storage.close();
  }
}

