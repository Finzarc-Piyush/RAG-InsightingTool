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
 * Build filter well fields + initial selections from dimension filters.
 * Columns already used as pivot rows only get `filterSelections` (same field is in slice keys).
 */
export function pivotSliceDefaultsFromDimensionFilters(
  dataSummary: DataSummary,
  dimensionFilters: DimensionFilter[] | undefined,
  pivotRowKeys: string[]
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
    if (!pivotRowKeys.includes(f.column) && !seenFilterWell.has(f.column)) {
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
