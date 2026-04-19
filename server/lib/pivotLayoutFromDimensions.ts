/**
 * Split non-numeric dimensions between pivot Rows and Columns using parser hints
 * or a conservative temporal-vs-categorical heuristic.
 */

import type { DataSummary } from "../shared/schema.js";
import { allowedColumnNamesForQueryPlan } from "./queryPlanExecutor.js";
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";

/** Parser output: at most one column id; allowed non-numeric schema names only. */
export function sanitisePivotColumnDimensionsInput(
  raw: unknown,
  dataSummary: DataSummary
): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns ?? []);
  for (const x of raw) {
    if (typeof x !== "string" || !x.trim()) continue;
    const c = x.trim();
    if (!allowed.has(c) || numeric.has(c)) continue;
    return [c];
  }
  return [];
}

function isTemporalPivotDimension(col: string, dataSummary: DataSummary): boolean {
  const dateSet = new Set(dataSummary.dateColumns ?? []);
  if (dateSet.has(col)) return true;
  if (isTemporalFacetColumnKey(col)) return true;
  if (dataSummary.temporalFacetColumns?.some((m) => m.name === col)) return true;
  return false;
}

export type SuggestPivotLayoutParams = {
  rowCandidates: string[];
  dataSummary: DataSummary;
  pivotColumnDimensions?: string[] | null | undefined;
};

/**
 * Returns row keys and at most one column key. Never empties `rowCandidates` entirely
 * (falls back to all rows, no columns).
 */
export function suggestPivotColumnsFromDimensions(
  params: SuggestPivotLayoutParams
): { rows: string[]; columns: string[] } {
  const { rowCandidates, dataSummary, pivotColumnDimensions } = params;
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns ?? []);

  if (!rowCandidates.length) {
    return { rows: [], columns: [] };
  }

  if (pivotColumnDimensions?.length) {
    let chosen: string | undefined;
    for (const c of pivotColumnDimensions) {
      if (typeof c !== "string" || !c.trim()) continue;
      const col = c.trim();
      if (!allowed.has(col) || numeric.has(col)) continue;
      if (!rowCandidates.includes(col)) continue;
      chosen = col;
      break;
    }
    if (chosen) {
      const newRows = rowCandidates.filter((r) => r !== chosen);
      if (newRows.length > 0) {
        return { rows: newRows, columns: [chosen] };
      }
    }
  }

  const temporals = rowCandidates.filter((c) =>
    isTemporalPivotDimension(c, dataSummary)
  );
  const cats = rowCandidates.filter((c) => !isTemporalPivotDimension(c, dataSummary));
  if (temporals.length >= 1 && cats.length >= 1) {
    const col = cats[0]!;
    return {
      rows: [...temporals, ...cats.slice(1)],
      columns: [col],
    };
  }

  return { rows: [...rowCandidates], columns: [] };
}
