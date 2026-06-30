/**
 * Client-side deterministic "Do" lane fallback for dashboard chart tiles.
 *
 * The server now strongly prefers emitting a `DO:` lane on every chart insight
 * (and appends a deterministic one when the model omits it), so freshly
 * generated / "Re-explain"-ed insights carry a manager-grade next step. This
 * module is the CONSUMPTION-side mirror ("fix both ends", L-018): for insights
 * that were PERSISTED before that change — and so have a headline (+ maybe a
 * Why) but no Do — it derives a concrete next step from the tile's own data so a
 * "Do:" line still renders without forcing a server round-trip / regeneration.
 *
 * It is a strict FALLBACK: `ChartInsightBody` only uses it when the parsed
 * `keyInsight` has no `DO:` lane of its own. Deliberately conservative — it only
 * fires for categorical bar / pie charts with enough buckets to name a clear
 * leader and laggard; everything else returns `null` (no Do rather than a
 * generic one).
 *
 * The bucketing helpers mirror the (now-removed) `tileRecommendations.ts`
 * aggregation — the same analytical signal, repurposed from "Try this" chips
 * into a managerial action.
 */

/** Minimal chart-spec shape the rule reads — strict subset of `ChartSpec`. */
export interface TileDoFallbackSpec {
  type: string;
  x: string;
  y: string;
  aggregate?: string;
  seriesColumn?: string;
}

/** Row shape consumed — strict subset of the embedded `ChartSpec.data` rows. */
export type TileDoFallbackRow = Record<string, string | number | boolean | null>;

/**
 * Chart types whose x-encoding is naturally categorical (each x value maps to
 * one bar / slice). Only these have a clean "leader vs laggard" reading; line /
 * area / scatter / heatmap have continuous or 2D x-encodings where the
 * comparison doesn't hold.
 */
const CATEGORICAL_X_TYPES = new Set(["bar", "pie"]);

/** Need at least this many buckets to name a meaningful top vs bottom. */
const MIN_BUCKETS = 3;

/**
 * Aggregate rows by their x-value, summing y per bucket. Skips rows whose x is
 * nullish / empty and rows whose y can't coerce to a finite number (dropping
 * null / "" BEFORE `Number()` so they don't become phantom 0 buckets).
 */
function aggregateByX(
  rows: TileDoFallbackRow[],
  xField: string,
  yField: string,
): Array<{ value: string; total: number }> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const xRaw = r[xField];
    if (xRaw === null || xRaw === undefined || xRaw === "") continue;
    const yRaw = r[yField];
    if (yRaw === null || yRaw === undefined || yRaw === "") continue;
    const y = typeof yRaw === "number" ? yRaw : Number(yRaw);
    if (!Number.isFinite(y)) continue;
    const x = String(xRaw);
    map.set(x, (map.get(x) ?? 0) + y);
  }
  return Array.from(map, ([value, total]) => ({ value, total }));
}

/**
 * Derive a concrete, grounded "Do" action from the tile's current spec +
 * filtered rows, or `null` when no confident action can be named. Pure — same
 * inputs always produce the same output. The returned string uses markdown
 * `**bold**` around the data-derived labels, matching how the rest of the
 * insight text is rendered (`renderInsightText`).
 */
export function deriveTileDoLane(
  spec: TileDoFallbackSpec,
  rows: TileDoFallbackRow[],
): string | null {
  if (!CATEGORICAL_X_TYPES.has(spec.type) || !spec.x || !spec.y) return null;

  const buckets = aggregateByX(rows, spec.x, spec.y);
  if (buckets.length < MIN_BUCKETS) return null;

  const sorted = buckets.slice().sort((a, b) => a.total - b.total);
  const lowest = sorted[0]!;
  const highest = sorted[sorted.length - 1]!;
  // A flat distribution (no real gap) has no clear leader/laggard to act on.
  if (highest.total <= lowest.total) return null;

  return (
    `Compare what **${highest.value}** does that **${lowest.value}** doesn't — ` +
    `break the gap down by region, pack or channel and shift effort (distribution, ` +
    `mix or pricing) toward what's working, or decide **${lowest.value}** isn't ` +
    `worth the investment.`
  );
}
