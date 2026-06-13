/**
 * dimensionFilterMatch.ts — shared categorical dimension-filter predicate.
 *
 * `passesFilter(row, filter)` was copy-pasted byte-for-byte across
 * marketBasketTool and rfmSegmentationTool. This is the one definition.
 *
 * It handles ONLY the categorical `in` / `not_in` operators with
 * exact / case_insensitive matching — the inline shape both tools use for
 * their row-level prefilter. It is deliberately narrower than the full
 * `DimensionFilter` type in shared/queryTypes.ts (which also carries scalar
 * comparison + range ops and a `contains` match mode); broadening it here
 * would change the accepted inputs. computeGrowthTool's Set-based
 * `applyDimensionFiltersInMemory` is a separate multi-filter variant and is
 * intentionally NOT consolidated.
 */

/** The categorical-only filter shape both market-basket / RFM tools accept. */
export interface CategoricalDimensionFilter {
  column: string;
  op: "in" | "not_in";
  values: string[];
  match?: "exact" | "case_insensitive";
}

export function passesFilter(
  row: Record<string, unknown>,
  filter: CategoricalDimensionFilter,
): boolean {
  const cell = row[filter.column];
  const cellStr = cell === null || cell === undefined ? "" : String(cell);
  const eq =
    filter.match === "case_insensitive"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  const matched = filter.values.some((v) => eq(cellStr, v));
  return filter.op === "in" ? matched : !matched;
}
