/**
 * Wave C9 · per-turn statistical-summary cache + multi-grain temporal pre-
 * compute + adaptive sample budgeting.
 *
 * Three responsibilities:
 *   1. **Stats cache**: memoise `(filter, column) → { mean, std, count, ... }`
 *      within a turn so chained tools don't recompute identical stats.
 *   2. **Temporal grain pre-compute**: build daily/weekly/monthly/quarterly/
 *      yearly aggregates lazily on first access; cache per session.
 *   3. **Adaptive sample budget**: chart / sample row caps scale with question
 *      complexity (cardinality of dimensions × time range × series count).
 */

export interface CachedNumericStats {
  count: number;
  sum: number;
  mean: number;
  std: number;
  min: number;
  max: number;
}

interface TurnStatsState {
  filterColumnCache: Map<string, CachedNumericStats>;
}

const turnStats = new Map<string, TurnStatsState>();

function statsKey(filter: Record<string, unknown> | undefined, column: string): string {
  const f = filter && Object.keys(filter).length > 0 ? JSON.stringify(filter) : "∅";
  return `${column}|${f}`;
}

export function statsForFilter(args: {
  turnId: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  filter?: Record<string, unknown>;
  column: string;
}): CachedNumericStats {
  let s = turnStats.get(args.turnId);
  if (!s) {
    s = { filterColumnCache: new Map() };
    turnStats.set(args.turnId, s);
  }
  const key = statsKey(args.filter, args.column);
  const cached = s.filterColumnCache.get(key);
  if (cached) return cached;
  const filtered = args.filter ? applyFilter(args.rows, args.filter) : args.rows;
  const stats = computeStats(filtered, args.column);
  s.filterColumnCache.set(key, stats);
  return stats;
}

export function clearTurnStats(turnId: string): void {
  turnStats.delete(turnId);
}

function applyFilter(
  rows: ReadonlyArray<Record<string, unknown>>,
  filter: Record<string, unknown>
): Record<string, unknown>[] {
  return rows.filter((row) => {
    for (const [k, v] of Object.entries(filter)) {
      const cell = row[k];
      if (Array.isArray(v)) {
        if (!v.some((x) => x === cell || String(cell).toLowerCase() === String(x).toLowerCase())) return false;
      } else if (cell !== v) {
        return false;
      }
    }
    return true;
  });
}

function computeStats(
  rows: ReadonlyArray<Record<string, unknown>>,
  column: string
): CachedNumericStats {
  const values: number[] = [];
  for (const r of rows) {
    const v = r[column];
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (Number.isFinite(n)) values.push(n);
  }
  if (values.length === 0) {
    return { count: 0, sum: 0, mean: 0, std: 0, min: 0, max: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: values.length, sum, mean, std, min, max };
}

// ─── Multi-grain temporal pre-compute ──────────────────────────────────────

export type TemporalGrain = "day" | "week" | "month" | "quarter" | "half_year" | "year";

export interface TemporalAggregate {
  bucket: string;
  rowCount: number;
  /** Numeric column → sum for that bucket. */
  sums: Record<string, number>;
}

interface TemporalCacheKey {
  sessionId: string;
  dateColumn: string;
  grain: TemporalGrain;
  numericColumns: string[];
}

const temporalCache = new Map<string, TemporalAggregate[]>();

function makeKey(k: TemporalCacheKey): string {
  return `${k.sessionId}|${k.dateColumn}|${k.grain}|${k.numericColumns.join(",")}`;
}

export function getOrBuildTemporalAggregate(args: {
  sessionId: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  dateColumn: string;
  grain: TemporalGrain;
  numericColumns: ReadonlyArray<string>;
}): TemporalAggregate[] {
  const key = makeKey({
    sessionId: args.sessionId,
    dateColumn: args.dateColumn,
    grain: args.grain,
    numericColumns: [...args.numericColumns],
  });
  const cached = temporalCache.get(key);
  if (cached) return cached;
  const out = buildTemporalAggregate(
    args.rows,
    args.dateColumn,
    args.grain,
    args.numericColumns
  );
  temporalCache.set(key, out);
  return out;
}

export function clearTemporalCache(sessionId: string): void {
  for (const k of temporalCache.keys()) {
    if (k.startsWith(`${sessionId}|`)) temporalCache.delete(k);
  }
}

function buildTemporalAggregate(
  rows: ReadonlyArray<Record<string, unknown>>,
  dateColumn: string,
  grain: TemporalGrain,
  numericColumns: ReadonlyArray<string>
): TemporalAggregate[] {
  const buckets = new Map<string, TemporalAggregate>();
  for (const row of rows) {
    const v = row[dateColumn];
    if (v === null || v === undefined || v === "") continue;
    const ms = Date.parse(String(v));
    if (!Number.isFinite(ms)) continue;
    const bucket = bucketLabel(new Date(ms), grain);
    let agg = buckets.get(bucket);
    if (!agg) {
      agg = { bucket, rowCount: 0, sums: Object.fromEntries(numericColumns.map((c) => [c, 0])) };
      buckets.set(bucket, agg);
    }
    agg.rowCount++;
    for (const c of numericColumns) {
      const cell = row[c];
      const n = typeof cell === "number" ? cell : parseFloat(String(cell));
      if (Number.isFinite(n)) agg.sums[c] = (agg.sums[c] ?? 0) + n;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

function bucketLabel(d: Date, grain: TemporalGrain): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  switch (grain) {
    case "day":
      return d.toISOString().slice(0, 10);
    case "week": {
      const week = Math.floor(d.getUTCDate() / 7) + 1;
      return `${y}-W${week}`;
    }
    case "month":
      return `${y}-${String(m).padStart(2, "0")}`;
    case "quarter":
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case "half_year":
      return `${y}-H${m <= 6 ? 1 : 2}`;
    case "year":
      return `${y}`;
  }
}

// ─── Adaptive sample budgeting ─────────────────────────────────────────────

export interface SampleBudgetInputs {
  /** Distinct values across the primary dimension. */
  primaryCardinality?: number;
  /** Distinct values across the second / series dimension. */
  seriesCardinality?: number;
  /** Number of time buckets being plotted. */
  timeBuckets?: number;
  /** Question shape — heuristic complexity boost. */
  questionShape?: string;
}

const BUDGET_FLOOR = 200;
const BUDGET_CEILING = 5_000;

export function adaptiveSampleBudget(inputs: SampleBudgetInputs): number {
  const dim = Math.max(1, inputs.primaryCardinality ?? 1);
  const series = Math.max(1, inputs.seriesCardinality ?? 1);
  const time = Math.max(1, inputs.timeBuckets ?? 1);
  const product = dim * series * time;
  // Aim for ~10 rows per cell. Square-root growth keeps the budget reasonable
  // for moderately complex charts.
  let budget = Math.round(Math.sqrt(product) * 50);
  if (
    inputs.questionShape === "driver_discovery" ||
    inputs.questionShape === "variance_diagnostic"
  ) {
    budget *= 2;
  }
  return Math.max(BUDGET_FLOOR, Math.min(BUDGET_CEILING, budget));
}
