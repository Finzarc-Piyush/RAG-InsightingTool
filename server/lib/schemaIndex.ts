/**
 * Wave C3 · SchemaIndex — pre-computed dataset metadata.
 *
 * Computed once per session (or rebuilt on data-version bump) so tools and
 * planner / reflector / narrator prompts read pre-cached distributions,
 * correlations, categorical associations, and anomaly indicators instead
 * of recomputing per-step.
 *
 * Cost: O(R × C) full pass on numeric columns + O(C²) on top-K column pairs.
 * For a 50k-row × 30-col dataset the boot is ~2-5 s; cached afterwards.
 *
 * Wave C4 will add live updates when `add_computed_columns` introduces a new
 * derived column.
 */

export type ColumnKind = "numeric" | "categorical" | "date" | "id" | "unknown";

export interface NumericStats {
  column: string;
  count: number;
  nullCount: number;
  mean: number;
  std: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  /** IQR-based outlier bounds: rows outside [low, high] are flagged. */
  outlierLow: number;
  outlierHigh: number;
}

export interface CategoricalStats {
  column: string;
  cardinality: number;
  nullCount: number;
  /** Full top-values list, frequency-sorted; not capped at 8. */
  topValues: Array<{ value: string; count: number }>;
  entropyBits: number;
}

export interface DateRange {
  column: string;
  min: string | null;
  max: string | null;
  rangeDays: number | null;
  hasGaps: boolean;
}

export interface CorrelationEntry {
  a: string;
  b: string;
  /** Pearson r (numeric × numeric). */
  pearson: number;
  /** Number of (a, b) pairs that contributed. */
  n: number;
}

export interface AssociationEntry {
  a: string;
  b: string;
  /** Cramér's V (categorical × categorical). 0 = independent, 1 = full assoc. */
  cramersV: number;
  n: number;
}

export interface AnomalyRecord {
  rowIndex: number;
  outlierColumns: string[];
}

export interface SchemaIndex {
  builtAt: number;
  dataVersion: number | null;
  rowCount: number;
  columnKinds: Record<string, ColumnKind>;
  numericStats: Record<string, NumericStats>;
  categoricalStats: Record<string, CategoricalStats>;
  dateRanges: Record<string, DateRange>;
  correlations: CorrelationEntry[];
  associations: AssociationEntry[];
  anomalies: { count: number; sample: AnomalyRecord[] };
}

const TOP_VALUES_BUDGET_CHARS = 4_000;
const CORRELATION_TOP_K_PAIRS = 30;
const ASSOCIATION_TOP_K_PAIRS = 20;
const ANOMALY_SAMPLE_LIMIT = 50;

const sessionIndexCache = new Map<string, SchemaIndex>();

export function getCachedSchemaIndex(sessionId: string): SchemaIndex | undefined {
  return sessionIndexCache.get(sessionId);
}

export function clearSchemaIndex(sessionId: string): void {
  sessionIndexCache.delete(sessionId);
}

/**
 * Wave C3 · build-or-reuse helper for the agent loop. Called at turn start
 * so tools / planner / narrator can read the typed index. Cheap when cached;
 * O(R × C) when first built. Rebuilds when `dataVersion` differs from the
 * cached version (covers upload / data-ops mutation cycles).
 */
export function ensureSchemaIndex(args: {
  sessionId: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  numericColumns: ReadonlyArray<string>;
  dateColumns: ReadonlyArray<string>;
  categoricalColumns: ReadonlyArray<string>;
  dataVersion: number | null;
}): SchemaIndex {
  const cached = sessionIndexCache.get(args.sessionId);
  if (cached && cached.dataVersion === args.dataVersion) return cached;
  return buildSchemaIndex(args);
}

export function buildSchemaIndex(args: {
  sessionId: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  numericColumns: ReadonlyArray<string>;
  dateColumns: ReadonlyArray<string>;
  categoricalColumns: ReadonlyArray<string>;
  dataVersion: number | null;
}): SchemaIndex {
  const { sessionId, rows, numericColumns, dateColumns, categoricalColumns, dataVersion } = args;
  const builtAt = Date.now();
  const rowCount = rows.length;

  const numericStats: Record<string, NumericStats> = {};
  for (const col of numericColumns) {
    numericStats[col] = computeNumericStats(rows, col);
  }
  const categoricalStats: Record<string, CategoricalStats> = {};
  for (const col of categoricalColumns) {
    categoricalStats[col] = computeCategoricalStats(rows, col);
  }
  const dateRanges: Record<string, DateRange> = {};
  for (const col of dateColumns) {
    dateRanges[col] = computeDateRange(rows, col);
  }
  const columnKinds: Record<string, ColumnKind> = {};
  for (const c of numericColumns) columnKinds[c] = "numeric";
  for (const c of categoricalColumns) columnKinds[c] = "categorical";
  for (const c of dateColumns) columnKinds[c] = "date";

  const correlations = computePairwisePearson(rows, numericColumns, CORRELATION_TOP_K_PAIRS);
  const associations = computePairwiseCramersV(
    rows,
    categoricalColumns,
    ASSOCIATION_TOP_K_PAIRS
  );
  const anomalies = computeAnomalies(rows, numericStats, ANOMALY_SAMPLE_LIMIT);

  const idx: SchemaIndex = {
    builtAt,
    dataVersion,
    rowCount,
    columnKinds,
    numericStats,
    categoricalStats,
    dateRanges,
    correlations,
    associations,
    anomalies,
  };
  sessionIndexCache.set(sessionId, idx);
  return idx;
}

// ─── Numeric stats (mean/std/percentiles/outlier bounds) ───────────────────

function computeNumericStats(
  rows: ReadonlyArray<Record<string, unknown>>,
  col: string
): NumericStats {
  const values: number[] = [];
  let nullCount = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") {
      nullCount++;
      continue;
    }
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (Number.isFinite(n)) values.push(n);
    else nullCount++;
  }
  if (values.length === 0) {
    return zeroNumericStats(col, nullCount);
  }
  values.sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const pct = (p: number) => {
    const idx = Math.min(values.length - 1, Math.floor((p / 100) * values.length));
    return values[idx];
  };
  const p25 = pct(25);
  const p75 = pct(75);
  const iqr = p75 - p25;
  return {
    column: col,
    count: values.length,
    nullCount,
    mean,
    std,
    min: values[0],
    p25,
    p50: pct(50),
    p75,
    p95: pct(95),
    p99: pct(99),
    max: values[values.length - 1],
    outlierLow: p25 - 1.5 * iqr,
    outlierHigh: p75 + 1.5 * iqr,
  };
}

function zeroNumericStats(column: string, nullCount: number): NumericStats {
  return {
    column,
    count: 0,
    nullCount,
    mean: 0,
    std: 0,
    min: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p95: 0,
    p99: 0,
    max: 0,
    outlierLow: 0,
    outlierHigh: 0,
  };
}

// ─── Categorical stats (cardinality, full topValues, entropy) ──────────────

function computeCategoricalStats(
  rows: ReadonlyArray<Record<string, unknown>>,
  col: string
): CategoricalStats {
  const counts = new Map<string, number>();
  let nullCount = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") {
      nullCount++;
      continue;
    }
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  // Top-values capped by character budget — ~4 KB total — instead of a fixed
  // count, so high-cardinality columns still surface their head values.
  const topValues: Array<{ value: string; count: number }> = [];
  let chars = 0;
  for (const [value, count] of sorted) {
    const next = value.length + String(count).length + 4;
    if (chars + next > TOP_VALUES_BUDGET_CHARS) break;
    chars += next;
    topValues.push({ value, count });
  }
  // Entropy in bits = -Σ p_i log2 p_i.
  const total = rows.length - nullCount;
  let entropy = 0;
  for (const [, c] of counts) {
    const p = c / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return {
    column: col,
    cardinality: counts.size,
    nullCount,
    topValues,
    entropyBits: entropy,
  };
}

// ─── Date ranges ───────────────────────────────────────────────────────────

function computeDateRange(
  rows: ReadonlyArray<Record<string, unknown>>,
  col: string
): DateRange {
  let minIso: string | null = null;
  let maxIso: string | null = null;
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    const ms = Date.parse(String(v));
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) {
      minMs = ms;
      minIso = new Date(ms).toISOString();
    }
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = new Date(ms).toISOString();
    }
  }
  return {
    column: col,
    min: minIso,
    max: maxIso,
    rangeDays:
      Number.isFinite(minMs) && Number.isFinite(maxMs)
        ? Math.round((maxMs - minMs) / (1000 * 60 * 60 * 24))
        : null,
    hasGaps: false, // populated by future C9 wave
  };
}

// ─── Pairwise Pearson (top-K numeric pairs) ────────────────────────────────

function computePairwisePearson(
  rows: ReadonlyArray<Record<string, unknown>>,
  cols: ReadonlyArray<string>,
  topK: number
): CorrelationEntry[] {
  const out: CorrelationEntry[] = [];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const a = cols[i];
      const b = cols[j];
      const r = pearsonCorrelation(rows, a, b);
      if (r === null) continue;
      out.push({ a, b, pearson: r.r, n: r.n });
    }
  }
  out.sort((x, y) => Math.abs(y.pearson) - Math.abs(x.pearson));
  return out.slice(0, topK);
}

function pearsonCorrelation(
  rows: ReadonlyArray<Record<string, unknown>>,
  a: string,
  b: string
): { r: number; n: number } | null {
  let sumA = 0;
  let sumB = 0;
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;
  let n = 0;
  for (const r of rows) {
    const va = toNumber(r[a]);
    const vb = toNumber(r[b]);
    if (va === null || vb === null) continue;
    sumA += va;
    sumB += vb;
    sumAB += va * vb;
    sumA2 += va * va;
    sumB2 += vb * vb;
    n++;
  }
  if (n < 5) return null;
  const num = n * sumAB - sumA * sumB;
  const den = Math.sqrt((n * sumA2 - sumA ** 2) * (n * sumB2 - sumB ** 2));
  if (!Number.isFinite(den) || den === 0) return null;
  return { r: num / den, n };
}

// ─── Pairwise Cramér's V (top-K categorical pairs) ─────────────────────────

function computePairwiseCramersV(
  rows: ReadonlyArray<Record<string, unknown>>,
  cols: ReadonlyArray<string>,
  topK: number
): AssociationEntry[] {
  const out: AssociationEntry[] = [];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const a = cols[i];
      const b = cols[j];
      const v = cramersV(rows, a, b);
      if (v === null) continue;
      out.push({ a, b, cramersV: v.v, n: v.n });
    }
  }
  out.sort((x, y) => y.cramersV - x.cramersV);
  return out.slice(0, topK);
}

function cramersV(
  rows: ReadonlyArray<Record<string, unknown>>,
  a: string,
  b: string
): { v: number; n: number } | null {
  // Build contingency table.
  const table = new Map<string, Map<string, number>>();
  const colA = new Map<string, number>();
  const colB = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const va = r[a];
    const vb = r[b];
    if (va === null || va === undefined || vb === null || vb === undefined) continue;
    const sa = String(va);
    const sb = String(vb);
    n++;
    let bucket = table.get(sa);
    if (!bucket) {
      bucket = new Map();
      table.set(sa, bucket);
    }
    bucket.set(sb, (bucket.get(sb) ?? 0) + 1);
    colA.set(sa, (colA.get(sa) ?? 0) + 1);
    colB.set(sb, (colB.get(sb) ?? 0) + 1);
  }
  if (n < 25 || colA.size < 2 || colB.size < 2) return null;
  // χ² = Σ (O - E)² / E
  let chi2 = 0;
  for (const [sa, bucket] of table) {
    for (const [sb, count] of bucket) {
      const expected = ((colA.get(sa) ?? 0) * (colB.get(sb) ?? 0)) / n;
      if (expected > 0) chi2 += (count - expected) ** 2 / expected;
    }
  }
  // Cramér's V = √(χ²/(n × (min(k-1, r-1))))
  const minDim = Math.min(colA.size - 1, colB.size - 1);
  if (minDim <= 0) return null;
  const v = Math.sqrt(chi2 / (n * minDim));
  return { v: Math.min(1, Math.max(0, v)), n };
}

// ─── Anomaly index (rows that are 2σ+ outliers in 2+ dimensions) ──────────

function computeAnomalies(
  rows: ReadonlyArray<Record<string, unknown>>,
  numericStats: Record<string, NumericStats>,
  sampleLimit: number
): { count: number; sample: AnomalyRecord[] } {
  const cols = Object.keys(numericStats);
  if (cols.length < 2) return { count: 0, sample: [] };
  const sample: AnomalyRecord[] = [];
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const flagged: string[] = [];
    for (const c of cols) {
      const stats = numericStats[c];
      const v = toNumber(r[c]);
      if (v === null) continue;
      if (v < stats.outlierLow || v > stats.outlierHigh) flagged.push(c);
    }
    if (flagged.length >= 2) {
      count++;
      if (sample.length < sampleLimit) sample.push({ rowIndex: i, outlierColumns: flagged });
    }
  }
  return { count, sample };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

/**
 * Wave C4 · live update for a single column. Called when `add_computed_columns`
 * or `derive_dimension_bucket` introduces a new derived column. Re-runs that
 * column's stats only, leaves the rest of the index intact.
 */
export function updateSchemaIndexColumn(args: {
  sessionId: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  column: string;
  kind: ColumnKind;
}): SchemaIndex | null {
  const idx = sessionIndexCache.get(args.sessionId);
  if (!idx) return null;
  idx.columnKinds[args.column] = args.kind;
  if (args.kind === "numeric") {
    idx.numericStats[args.column] = computeNumericStats(args.rows, args.column);
  } else if (args.kind === "categorical") {
    idx.categoricalStats[args.column] = computeCategoricalStats(args.rows, args.column);
  } else if (args.kind === "date") {
    idx.dateRanges[args.column] = computeDateRange(args.rows, args.column);
  }
  idx.builtAt = Date.now();
  return idx;
}
