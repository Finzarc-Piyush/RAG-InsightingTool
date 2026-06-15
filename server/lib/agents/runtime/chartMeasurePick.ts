/**
 * ============================================================================
 * chartMeasurePick.ts — shared x/y axis-pick heuristics for table→chart builders
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Two tiny pure predicates the deterministic chart builders use to turn a
 *   result table into a chart:
 *     - isNumericishOnSample — is a column numeric-looking on a small sample
 *       (used to split columns into measures vs dimensions)?
 *     - scoreMeasure — rank a numeric column by how "measure-like" its NAME is,
 *       so the y-axis prefers a computed rate / aggregate alias over raw helper
 *       columns.
 *
 * WHY IT MATTERS
 *   These were copy-pasted into both chartFromTable.ts (the chart-promotion path)
 *   and visualPlanner.ts (the deterministic fallback). The two copies DRIFTED —
 *   visualPlanner's scoreMeasure lost chartFromTable's `__matching`/`__total`
 *   guard and the `_rate`/`_pct` bonus — so the two paths, whose own comments say
 *   they run "in lockstep", silently picked different y-axes for boolean-indicator
 *   rate breakdowns. Hoisting both predicates here is the single authority so the
 *   two builders can never diverge again.
 *
 * HOW IT CONNECTS
 *   Imported by chartFromTable.buildChartFromAnalyticalTable and the
 *   visualPlanner deterministic fallback. Pure — no IO, no dataset assumptions.
 */

/**
 * True when `col` holds numeric-looking values on the sample (number, or a
 * string that parses to a finite number after stripping `%`/`,`). Scans at most
 * the first 20 non-empty cells. Used to split a result table's columns into
 * numeric measures vs categorical dimensions.
 */
export function isNumericishOnSample(
  col: string,
  sample: Record<string, unknown>[]
): boolean {
  const cap = Math.min(20, sample.length);
  for (let i = 0; i < cap; i++) {
    const v = sample[i]?.[col];
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) return true;
    if (typeof v === "string") {
      const cleaned = v.replace(/[%,]/g, "").trim();
      if (cleaned && Number.isFinite(Number(cleaned))) return true;
    }
  }
  return false;
}

/**
 * Rank a numeric column by how "measure-like" its name is, so the y-axis picks
 * the most meaningful measure when a table has several numeric columns.
 */
export function scoreMeasure(col: string): number {
  const n = col.toLowerCase();
  // countIf-ratio helper columns (`<base>__matching` / `<base>__total`) are the
  // numerator/denominator behind a computed rate — never the measure to chart.
  // Force them below everything so the rate alias wins the y-axis. (Targets the
  // double-underscore helper convention only, so single-underscore aliases like
  // a user's `revenue_total` are unaffected.)
  if (/__matching\b|__total\b/.test(n)) return -1;
  return (
    // A computed rate/share alias (e.g. `pjp_adherence_rate`) outranks raw
    // aggregates: for a boolean-indicator breakdown the RATE is the measure,
    // not the underlying matching/total counts.
    (/_rate\b|_ratio\b|_share\b|_pct\b/.test(n) ? 6 : 0) +
    (/_sum\b/.test(n) ? 5 : 0) +
    (/_avg\b/.test(n) || /_mean\b/.test(n) ? 4 : 0) +
    (/_count\b/.test(n) ? 3 : 0) +
    (/_min\b/.test(n) || /_max\b/.test(n) ? 2 : 0) +
    (/_total\b/.test(n) ? 1 : 0)
  );
}
