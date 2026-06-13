/**
 * Map analytical dimensionFilters (op "in") into pivot UI slice defaults.
 */

import type { DimensionFilter } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";
import { allowedColumnNamesForQueryPlan } from "./queryPlanExecutor.js";

export type PivotSliceDefaults = {
  filterFields: string[];
  filterSelections: Record<string, string[]>;
};

/**
 * Parse a raw `parsedQuery.dimensionFilters` blob into a typed `DimensionFilter[]`.
 * Returns `undefined` when absent or when no valid (`in`/`not_in`) filters survive.
 */
export function readDimensionFiltersFromParsed(
  parsedQuery: Record<string, unknown> | null | undefined
): DimensionFilter[] | undefined {
  if (!parsedQuery) return undefined;
  const raw = parsedQuery.dimensionFilters;
  if (!Array.isArray(raw)) return undefined;
  const out: DimensionFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.column !== "string") continue;
    if (o.op !== "in" && o.op !== "not_in") continue;
    if (!Array.isArray(o.values)) continue;
    out.push({
      column: o.column,
      op: o.op as "in" | "not_in",
      values: o.values.map((v) => String(v)),
      match:
        o.match === "exact" ||
        o.match === "case_insensitive" ||
        o.match === "contains"
          ? o.match
          : undefined,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Build filter well fields + initial selections from dimension filters.
 * Fields on pivot rows or pivot columns only get `filterSelections` (same field is in slice keys).
 */
export function pivotSliceDefaultsFromDimensionFilters(
  dataSummary: DataSummary,
  dimensionFilters: DimensionFilter[] | undefined,
  pivotRowKeys: string[],
  pivotColumnKeys: string[] = []
): PivotSliceDefaults {
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns ?? []);
  const filterFields: string[] = [];
  const filterSelections: Record<string, string[]> = {};
  if (!dimensionFilters?.length) {
    return { filterFields, filterSelections };
  }
  const seenFilterWell = new Set<string>();
  for (const f of dimensionFilters) {
    if (!f || f.op !== "in") continue;
    if (!allowed.has(f.column) || numeric.has(f.column)) continue;
    const vals = (f.values || [])
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (!vals.length) continue;
    filterSelections[f.column] = [...vals];
    const onPivotAxis =
      pivotRowKeys.includes(f.column) || pivotColumnKeys.includes(f.column);
    if (!onPivotAxis && !seenFilterWell.has(f.column)) {
      seenFilterWell.add(f.column);
      filterFields.push(f.column);
    }
  }
  return { filterFields, filterSelections };
}

/** Execution overrides parser per field; filter well list prefers execution order then parser. */
export function mergePivotSliceDefaults(
  parserSlice: PivotSliceDefaults,
  executionSlice: PivotSliceDefaults
): PivotSliceDefaults {
  const filterSelections = {
    ...parserSlice.filterSelections,
    ...executionSlice.filterSelections,
  };
  const filterFields = [
    ...new Set([
      ...executionSlice.filterFields,
      ...parserSlice.filterFields,
    ]),
  ];
  return { filterFields, filterSelections };
}
