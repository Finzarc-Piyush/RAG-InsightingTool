import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";

/**
 * Coerce temporal facet bucket keys (e.g. __tf_year__...) to strings.
 * Temporal facets are categorical labels; if they become numbers, the UI may
 * format them like measures (e.g. `2015` -> `2,015`).
 *
 * Mutates input rows in-place.
 */
export function coerceTemporalFacetKeysToStrings(
  rows: Array<Record<string, unknown>>
): void {
  if (!Array.isArray(rows) || rows.length === 0) return;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!isTemporalFacetColumnKey(key)) continue;
      const v = (row as any)[key];
      if (v === null || v === undefined) continue;
      (row as any)[key] = String(v);
    }
  }
}

