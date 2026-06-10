/**
 * Derive pivot row/value hints from an analytical preview table so defaults match
 * actual output column ids (temporal facets, Sales_sum, etc.), not only schema parse names.
 *
 * Pivot queries always read the base DuckDB `data` table, so value fields must be real
 * numeric schema columns (e.g. `Sales`), not SQL aliases like `Total_Revenue` or `Sales_sum`.
 */
// W27 · path was off by one segment (file lives in `server/lib/`, schema in
// `server/shared/`). Pre-existing typecheck noise; pure import-path fix.
import type { DataSummary } from "../shared/schema.js";
import { resolveMetricAliasToSchemaColumn } from "./agents/runtime/plannerColumnResolve.js";
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";
import { suggestPivotColumnsFromDimensions } from "./pivotLayoutFromDimensions.js";

const AGG_SUFFIX = /_(sum|avg|mean|min|max|count)$/i;
const AGG_SUFFIX_CAPTURE = /^(.*)_(sum|avg|mean|min|max|count)$/i;

// countIf-ratio helper columns (`<base>__matching` / `<base>__total`) are the
// numerator/denominator behind a computed rate — they exist only in the
// analytical result set, never on the raw `data` table a pivot re-queries.
// Mirrors the scoreMeasure guard in agents/runtime/chartFromTable.ts. Targets
// the DOUBLE-underscore helper convention only, so a user's legitimate
// single-underscore column (e.g. `revenue_total`, `conversion_rate`) is safe.
const COMPUTED_HELPER_FIELD = /__matching\b|__total\b/i;

/**
 * Map preview/aggregate output column names to a column that exists on the base table.
 */
export function normalizePivotValueFieldForBaseTable(
  col: string,
  summary: DataSummary
): string {
  const numericSchema = new Set(summary.numericColumns ?? []);
  if (numericSchema.has(col)) return col;

  const m = col.match(AGG_SUFFIX_CAPTURE);
  if (m?.[1] && numericSchema.has(m[1])) {
    return m[1];
  }

  const colObjs = (summary.columns ?? []).map((c) => ({ name: c.name }));
  const resolved = resolveMetricAliasToSchemaColumn(
    col,
    colObjs,
    summary.numericColumns ?? []
  );
  if (numericSchema.has(resolved)) return resolved;

  return col;
}

/**
 * Keep only pivot value fields that map to a REAL numeric column on the base
 * `data` table. A dashboard pivot tile re-runs `SELECT <values> FROM data`, so
 * any value field that is an analytical-result alias (computed rate like
 * `pjp_adherence_rate`, or a countIf helper like `matching` / `total`) — i.e.
 * not present in `summary.numericColumns` — would throw a DuckDB binder error
 * at render time. This codifies, as one reusable function, the same contract
 * the chat-side PVT2 guard enforces in pivotDefaultsFromExecution.ts.
 *
 * Normalises each field first (so `Sales_sum` → `Sales`), drops anything not in
 * `numericColumns`, drops the `__matching` / `__total` helper convention
 * outright, and de-dupes. Pure (no I/O).
 */
export function filterPivotValueFieldsToBaseTable(
  values: string[],
  summary: DataSummary
): string[] {
  const numericSchema = new Set(summary.numericColumns ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (COMPUTED_HELPER_FIELD.test(v)) continue;
    const normalized = normalizePivotValueFieldForBaseTable(v, summary);
    if (!numericSchema.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function idLikeDimensionName(col: string): boolean {
  const c = col.trim().toLowerCase();
  return c === "id" || c.endsWith("_id") || c === "row id" || c.startsWith("row id");
}

function isMeasureColumn(
  col: string,
  sample: unknown,
  numericSchema: Set<string>
): boolean {
  if (isTemporalFacetColumnKey(col)) return false;
  if (AGG_SUFFIX.test(col)) return true;
  if (numericSchema.has(col)) return true;
  if (idLikeDimensionName(col)) return false;
  if (typeof sample === "number" && Number.isFinite(sample)) return true;
  if (sample == null || sample === "") return false;
  const s = String(sample).trim().replace(/,/g, "");
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return true;
  return false;
}

export type PivotDefaultsFromPreview = {
  rows: string[];
  values: string[];
  columns?: string[];
};

/**
 * @param columnOrder - Prefer tool `table.columns` when present so order matches SQL SELECT.
 */
export function derivePivotDefaultsFromPreviewRows(
  rows: Record<string, unknown>[],
  summary: DataSummary,
  columnOrder?: string[] | null
): PivotDefaultsFromPreview | undefined {
  if (!rows.length) return undefined;
  const sample = rows[0];
  if (!sample || typeof sample !== "object") return undefined;

  const keysFromRow = Object.keys(sample);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const prefer = Array.isArray(columnOrder) ? columnOrder : null;
  if (prefer?.length) {
    for (const k of prefer) {
      if (!k || seen.has(k)) continue;
      if (!(k in sample)) continue;
      seen.add(k);
      ordered.push(k);
    }
  }
  for (const k of keysFromRow) {
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(k);
  }

  const numericSchema = new Set(summary.numericColumns ?? []);

  const rowKeys: string[] = [];
  const valueKeys: string[] = [];
  for (const col of ordered) {
    const v = sample[col];
    if (isMeasureColumn(col, v, numericSchema)) {
      if (!valueKeys.includes(col)) valueKeys.push(col);
    } else {
      if (!rowKeys.includes(col)) rowKeys.push(col);
    }
  }

  if (rowKeys.length === 0 && valueKeys.length === 0) return undefined;

  // Normalise + drop any value field that isn't a real base-table numeric
  // column (computed rate / countIf-helper aliases). Without this the dashboard
  // pivot tile re-queries a nonexistent column and surfaces a binder error.
  const normalizedValues = filterPivotValueFieldsToBaseTable(valueKeys, summary);

  const layout = suggestPivotColumnsFromDimensions({
    rowCandidates: rowKeys,
    dataSummary: summary,
    pivotColumnDimensions: undefined,
  });

  const out: PivotDefaultsFromPreview = {
    rows: layout.rows,
    values: normalizedValues,
  };
  if (layout.columns.length) {
    out.columns = layout.columns;
  }
  return out;
}
