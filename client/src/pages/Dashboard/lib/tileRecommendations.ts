/**
 * Wave WI5 · per-tile "Try this" recommendation derivation.
 *
 * The existing `DashboardAnswerEnvelope.recommendations` array surfaces
 * LLM-generated, prose-style recommendations grouped by horizon (now /
 * this-quarter / strategic) at the **whole-analysis** scope. WI5 is the
 * per-tile counterpart: lightweight, deterministic, single-click CTAs
 * derived from the tile's current data + filter state. No LLM, no
 * server round-trip — the rules are simple enough to run synchronously
 * on every render.
 *
 * Closes Workstream 7 to 5 of 6 — the recommendations infra was already
 * partially built (RecommendationsByHorizon in AnalysisSummaryPanel),
 * WI5 scopes it down to "this tile" rather than "this analysis".
 *
 * Rule set (deterministic, deliberately conservative so chips don't
 * spam the footer):
 *
 *   - **filter-bottom** — when the lowest-aggregated x-bucket has a
 *     total < median × 0.5, surface "Focus lowest: <value>" so the user
 *     can drill into the underperforming category. Only fires for
 *     categorical-x chart types ("bar" / "pie") with ≥3 buckets — a
 *     median is meaningless with <3 datapoints.
 *   - **filter-top** — mirror rule for the highest-aggregated bucket
 *     when its total > median × 2.0. "Focus highest: <value>".
 *   - **clear-filters** — always-on when at least one filter is active.
 *     Slotted last so value-driven CTAs render first.
 *
 * Capped at MAX_TILE_RECOMMENDATIONS = 3 so the chip row never wraps
 * into a multi-line block that pushes the chart down.
 *
 * Backward-compat: this module is purely additive. Consumers that don't
 * import it stay byte-identical.
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";

/**
 * Minimal chart-spec shape the rules read. Strict subset of `ChartSpec`
 * (and of `InsightChartSpecLite` from useInsightRegen) — we deliberately
 * don't re-export those types here to keep the module zero-coupling
 * with the regen pipeline. A tile that has no regen wiring can still
 * surface recommendations.
 */
export interface TileRecommendationSpec {
  type: string;
  x: string;
  y: string;
  aggregate?: string;
  seriesColumn?: string;
}

/** Row shape the rules consume — strict subset of `InsightRegenRow`. */
export type TileRecommendationRow = Record<string, string | number | boolean | null>;

/**
 * A "Try this" CTA the user can apply via a single click. Discriminated
 * by `kind` so the consumer's click-handler can route each variant to
 * the right state mutation (apply a categorical filter / clear all
 * filters / etc.). New kinds added later (e.g. "focus-outlier" for
 * scatter, "brush-anomaly" for trend) join this union without breaking
 * existing call sites.
 */
export type TileRecommendation =
  | {
      kind: "filter-bottom";
      /** Stable id (used as React `key`). */
      id: string;
      /** Short human-readable label rendered in the chip. */
      label: string;
      /** Column the filter targets. */
      column: string;
      /** Value to filter to. */
      value: string;
    }
  | {
      kind: "filter-top";
      id: string;
      label: string;
      column: string;
      value: string;
    }
  | {
      kind: "clear-filters";
      id: string;
      label: string;
    };

/** Cap on simultaneously-surfaced recommendations. Keeps the chip row to one line. */
export const MAX_TILE_RECOMMENDATIONS = 3;

/**
 * Threshold for the filter-bottom rule. A bucket fires the rule when
 * its aggregated total drops below `median × FILTER_BOTTOM_RATIO`. 0.5
 * means "less than half the median" — chosen so the rule is loud
 * enough to be useful but doesn't fire on every mild dip.
 */
export const FILTER_BOTTOM_RATIO = 0.5;

/**
 * Threshold for the filter-top rule. Mirror of FILTER_BOTTOM_RATIO at
 * 2.0 — fires when a bucket's total is at least twice the median.
 */
export const FILTER_TOP_RATIO = 2.0;

/**
 * Chart types whose x-encoding is naturally categorical (each x value
 * maps to one chart mark / slice / bar). Bar + pie are the safe set
 * for the filter-bottom/top rules — line / area / scatter / heatmap
 * have continuous or 2D x-encodings where "filter to the bottom
 * bucket" doesn't have a clean meaning.
 */
const CATEGORICAL_X_TYPES = new Set(["bar", "pie"]);

/**
 * Aggregate rows by their x-value, summing y-values per bucket. Skips
 * rows whose x is nullish / empty-string and rows whose y can't coerce
 * to a finite number. The sum aggregator matches the default for the
 * bar / pie ChartSpec types this rule applies to; the rule's threshold
 * is relative (median-anchored) so a different aggregator on the
 * original chart wouldn't change the relative ordering.
 */
function aggregateByX(
  rows: TileRecommendationRow[],
  xField: string,
  yField: string,
): Array<{ value: string; total: number }> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const xRaw = r[xField];
    if (xRaw === null || xRaw === undefined || xRaw === "") continue;
    const yRaw = r[yField];
    // Drop null / undefined / empty-string y BEFORE `Number()` — without
    // this guard, `Number(null)` and `Number("")` both coerce to 0 and
    // would silently create phantom buckets at 0 that shift the median
    // down. Matches the null-drop convention in
    // `filterRowsByBrushRegion` in `explainSlice.ts`.
    if (yRaw === null || yRaw === undefined || yRaw === "") continue;
    const y = typeof yRaw === "number" ? yRaw : Number(yRaw);
    if (!Number.isFinite(y)) continue;
    const x = String(xRaw);
    map.set(x, (map.get(x) ?? 0) + y);
  }
  return Array.from(map, ([value, total]) => ({ value, total }));
}

/** Median of a numeric array (does not mutate input). Returns 0 for empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * True iff the active filter on `column` already pins `value` (so we
 * shouldn't re-surface a recommendation that would be a no-op). A
 * numeric-or-date filter on the same column does NOT count — those
 * narrow the range without pinning a specific categorical value.
 */
function isValueAlreadyFiltered(
  activeFilters: ActiveChartFilters,
  column: string,
  value: string,
): boolean {
  const f = activeFilters[column];
  if (!f || f.type !== "categorical") return false;
  return f.values.includes(value);
}

/**
 * Derive up to MAX_TILE_RECOMMENDATIONS "Try this" CTAs from the tile's
 * current spec + filtered rows + active filters. Pure function — same
 * inputs always produce same outputs.
 */
export function deriveTileRecommendations(
  spec: TileRecommendationSpec,
  rows: TileRecommendationRow[],
  activeFilters: ActiveChartFilters,
): TileRecommendation[] {
  const recs: TileRecommendation[] = [];

  if (CATEGORICAL_X_TYPES.has(spec.type) && spec.x && spec.y) {
    const buckets = aggregateByX(rows, spec.x, spec.y);
    if (buckets.length >= 3) {
      const med = median(buckets.map((b) => b.total));
      if (med > 0) {
        const sorted = buckets.slice().sort((a, b) => a.total - b.total);
        const lowest = sorted[0];
        const highest = sorted[sorted.length - 1];
        if (
          lowest.total < med * FILTER_BOTTOM_RATIO &&
          !isValueAlreadyFiltered(activeFilters, spec.x, lowest.value)
        ) {
          recs.push({
            kind: "filter-bottom",
            id: `filter-bottom:${spec.x}:${lowest.value}`,
            label: `Focus lowest: ${lowest.value}`,
            column: spec.x,
            value: lowest.value,
          });
        }
        if (
          highest.total > med * FILTER_TOP_RATIO &&
          !isValueAlreadyFiltered(activeFilters, spec.x, highest.value)
        ) {
          recs.push({
            kind: "filter-top",
            id: `filter-top:${spec.x}:${highest.value}`,
            label: `Focus highest: ${highest.value}`,
            column: spec.x,
            value: highest.value,
          });
        }
      }
    }
  }

  const hasActiveFilters = Object.values(activeFilters).some((s) => s !== undefined);
  if (hasActiveFilters) {
    recs.push({
      kind: "clear-filters",
      id: "clear-filters",
      label: "Clear filters",
    });
  }

  return recs.slice(0, MAX_TILE_RECOMMENDATIONS);
}
