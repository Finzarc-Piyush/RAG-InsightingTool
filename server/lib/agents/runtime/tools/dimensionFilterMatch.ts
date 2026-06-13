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

import { z } from "zod";

/** The categorical-only filter shape both market-basket / RFM tools accept. */
export interface CategoricalDimensionFilter {
  column: string;
  op: "in" | "not_in";
  values: string[];
  match?: "exact" | "case_insensitive";
}

/**
 * Strict categorical filter schema matching what `passesFilter` consumes:
 * in/not_in with exact|case_insensitive matching, non-empty column + values.
 * Single source of truth for the `dimensionFilters` arg in tools that prefilter
 * rows with `passesFilter` (cohort, hierarchicalDrill, priceElasticity) plus
 * marketBasket / rfm.
 */
export const categoricalDimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()).min(1),
    match: z.enum(["exact", "case_insensitive"]).optional(),
  })
  .strict();

/**
 * Broader categorical filter schema that also allows a `contains` match mode
 * (and does not require non-empty column/values). Used by tools whose filtering
 * goes through `dataTransform.filterRowsByDimensionFilters` — which implements
 * `contains` — i.e. anomaly, breakdownRanking, significanceTest, computeGrowth,
 * detectSeasonality, twoSegment.
 */
export const dimensionFilterWithContainsSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

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
