/**
 * ============================================================================
 * performanceStanding.ts — the "obvious business read" a manager already knows
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A manager running ~10 brands knows, before opening the tool, which channel
 *   leads and which trails ("obviously GT beats Q-com"). When the answer just
 *   re-states raw numbers without that ranking, it reads as a naive observation,
 *   not an insight. This pure function reads the turn's main analytical table
 *   (a single categorical dimension × a single primary measure) and computes a
 *   deterministic STANDING: who leads, who trails, each unit's share and its
 *   distance from the group mean, plus how concentrated the dimension is.
 *
 *   It is the ranked complement of `computeAttentionAreas` (which only flags
 *   below-mean units). Here we want the WHOLE order, leader included, so the
 *   narrator can state the obvious as the FLOOR — then spend its words on what
 *   the manager does NOT already know.
 *
 * WHY IT MATTERS
 *   Deterministic + derived from the displayed table, so it never contradicts a
 *   number the user can see and costs no extra LLM call. It is intentionally
 *   CONSERVATIVE: it returns null on any ambiguous shape (multiple categorical
 *   dimensions, no clean primary measure, too few units, a temporal/trend
 *   frame). Better to impose no standing than a wrong one (L-043).
 *
 * HOW IT CONNECTS
 *   Called by `buildPerformanceStandingBlock` (narratorHintsBlock.ts) with
 *   `ctx.lastAnalyticalTable.{columns, rows}` and `ctx.summary.dateColumns`; the
 *   rendered block is threaded into the narrator's USER prompt.
 */

export type StandingTone = "green" | "amber" | "red";

export interface StandingUnit {
  /** The dimension value, e.g. "GT" / "Q-com" / "Saffola". */
  unit: string;
  /** This unit's measure value. */
  value: number;
  /** 1 = best on the metric (lowest when the metric is lower-is-better). */
  rank: number;
  /** value as a % of the total across units (0 when total is 0 / mixed signs). */
  sharePct: number;
  /** % distance from the group mean (signed). */
  vsMeanPct: number;
  /** green = clear leader tier; red = >1 SD on the bad side; amber = the rest. */
  tone: StandingTone;
}

export interface PerformanceStanding {
  dimension: string;
  metric: string;
  /** Whether a LOWER value is better for this metric (cost, non-compliance…). */
  lowerIsBetter: boolean;
  /** Best → worst. */
  units: StandingUnit[];
  leader: StandingUnit;
  laggard: StandingUnit;
  mean: number;
  total: number;
  /** Leader's share of the total — the concentration headline. */
  leaderSharePct: number;
  /** Top-3 combined share — "the dimension is dominated by a few". */
  top3SharePct: number;
}

export interface PerformanceStandingOptions {
  /** Columns known to be dates — excluded from both dimension and measure roles. */
  dateColumns?: readonly string[];
  /** Minimum distinct units for a meaningful ranking. Default 3. */
  minUnits?: number;
}

interface TableLike {
  columns?: readonly string[];
  rows?: ReadonlyArray<Record<string, unknown>>;
}

const ROLLUP_UNIT_RE =
  /^(total|grand\s*total|all|overall|others?|n\/?a|unknown|null|\(blank\))$/i;
// Metrics where LOWER is better — invert the ranking so "leader" = lowest.
const LOWER_IS_BETTER_RE =
  /\b(cost|spend|non[-\s]?compliance|non[-\s]?compliant|absent|late|error|defect|complaint|churn|attrition|return rate|days? to|lead time|stockout|out[-\s]?of[-\s]?stock|gap|miss(?:ed|es)?)\b/i;
// Numeric columns that are NOT primary measures (avoid ranking by a year/id/%).
const NON_MEASURE_RE = /\b(year|yr|id|code|rank|index|pincode|zip|phone)\b/i;

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v === null || v === undefined || v === "") return NaN;
  return Number(String(v).replace(/[%,₹$\s]/g, ""));
}

function isNumericColumn(
  rows: ReadonlyArray<Record<string, unknown>>,
  col: string
): boolean {
  let seen = 0;
  let numeric = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    seen += 1;
    if (Number.isFinite(toNumber(v))) numeric += 1;
    if (seen >= 20) break;
  }
  return seen > 0 && numeric / seen >= 0.8;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / xs.length);
}

/**
 * Compute a deterministic performance standing from a categorical-breakdown
 * table. Returns null on any ambiguous / non-breakdown shape — the caller then
 * emits no block and the narrator proceeds normally.
 */
export function computePerformanceStanding(
  table: TableLike | undefined,
  options: PerformanceStandingOptions = {}
): PerformanceStanding | null {
  const columns = table?.columns ?? [];
  const rows = table?.rows ?? [];
  const minUnits = options.minUnits ?? 3;
  const dateCols = new Set((options.dateColumns ?? []).map((c) => c));
  if (columns.length < 2 || rows.length < minUnits) return null;

  // Partition columns into categorical (string-y, non-date) vs numeric measures.
  const categorical: string[] = [];
  const numeric: string[] = [];
  for (const col of columns) {
    if (dateCols.has(col)) continue;
    if (isNumericColumn(rows, col)) numeric.push(col);
    else categorical.push(col);
  }
  // Unambiguous shape only: exactly one thing to rank, by one clear measure.
  if (categorical.length !== 1) return null;
  const dimension = categorical[0]!;
  const measureCandidates = numeric.filter((c) => !NON_MEASURE_RE.test(c));
  if (measureCandidates.length === 0) return null;
  const metric = measureCandidates[0]!;

  // Materialise (unit, value), dropping rollup rows and non-finite values.
  const points: Array<{ unit: string; value: number }> = [];
  for (const r of rows) {
    const unit = String(r[dimension] ?? "").trim();
    const value = toNumber(r[metric]);
    if (!unit || ROLLUP_UNIT_RE.test(unit) || !Number.isFinite(value)) continue;
    points.push({ unit, value });
  }
  if (points.length < minUnits) return null;

  const lowerIsBetter =
    LOWER_IS_BETTER_RE.test(metric) || LOWER_IS_BETTER_RE.test(dimension);
  const values = points.map((p) => p.value);
  const mu = mean(values);
  const sd = stddev(values, mu);
  const total = values.reduce((a, b) => a + b, 0);
  const shareSafe = total > 0 && values.every((v) => v >= 0);

  // Sort best → worst (desc for higher-is-better, asc for lower-is-better).
  const sorted = [...points].sort((a, b) =>
    lowerIsBetter ? a.value - b.value : b.value - a.value
  );

  const units: StandingUnit[] = sorted.map((p, i) => {
    const onBadSide = lowerIsBetter ? p.value > mu : p.value < mu;
    const critical = sd > 0 && (lowerIsBetter ? p.value > mu + sd : p.value < mu - sd);
    const tone: StandingTone = i === 0 ? "green" : critical ? "red" : onBadSide ? "amber" : "green";
    return {
      unit: p.unit,
      value: p.value,
      rank: i + 1,
      sharePct: shareSafe ? (p.value / total) * 100 : 0,
      vsMeanPct: mu !== 0 ? ((p.value - mu) / Math.abs(mu)) * 100 : 0,
      tone,
    };
  });

  const leader = units[0]!;
  const laggard = units[units.length - 1]!;
  const top3SharePct = shareSafe
    ? units.slice(0, 3).reduce((a, u) => a + u.sharePct, 0)
    : 0;

  return {
    dimension,
    metric,
    lowerIsBetter,
    units,
    leader,
    laggard,
    mean: mu,
    total,
    leaderSharePct: leader.sharePct,
    top3SharePct,
  };
}
