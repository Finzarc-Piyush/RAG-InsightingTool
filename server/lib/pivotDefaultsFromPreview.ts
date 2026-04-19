/**
 * Derive pivot row/value hints from an analytical preview table so defaults match
 * actual output column ids (temporal facets, Sales_sum, etc.), not only schema parse names.
 *
 * Pivot queries always read the base DuckDB `data` table, so value fields must be real
 * numeric schema columns (e.g. `Sales`), not SQL aliases like `Total_Revenue` or `Sales_sum`.
 */
import type { DataSummary } from "../../shared/schema.js";
import { resolveMetricAliasToSchemaColumn } from "./agents/runtime/plannerColumnResolve.js";
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";
import { suggestPivotColumnsFromDimensions } from "./pivotLayoutFromDimensions.js";

const AGG_SUFFIX = /_(sum|avg|mean|min|max|count)$/i;
const AGG_SUFFIX_CAPTURE = /^(.*)_(sum|avg|mean|min|max|count)$/i;

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

  const normalizedValues: string[] = [];
  const seenVal = new Set<string>();
  for (const v of valueKeys) {
    const n = normalizePivotValueFieldForBaseTable(v, summary);
    if (seenVal.has(n)) continue;
    seenVal.add(n);
    normalizedValues.push(n);
  }

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
