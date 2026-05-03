// WSE1 · Pure seasonality math.
//
// Given a set of (year, position, value) triples — where `position` is
// month-of-year (1–12) or quarter-of-year (1–4) — compute:
//   - the per-position mean and seasonality index
//     (index = mean_at_position / overall_mean, so index = 1.0 means average)
//   - peak consistency across years (does the SAME position rank in the
//     top-K every year? this is the signal the user wants — "Oct/Nov/Dec
//     peak EVERY year")
//   - strength tier (strong / moderate / weak / none)
//   - a human-readable summary line for the narrator
//
// Pure functions, deterministic, no I/O. SQL aggregation lives in
// buildSeasonalityAggSql.ts; the tool wrapper lives in
// detectSeasonalityTool.ts.

export type SeasonalityGrain = "month" | "quarter";

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const QUARTER_LABELS = ["Q1", "Q2", "Q3", "Q4"];

export function positionLabel(grain: SeasonalityGrain, position: number): string {
  if (grain === "month") {
    if (position < 1 || position > 12) return `M${position}`;
    return MONTH_LABELS[position - 1];
  }
  if (position < 1 || position > 4) return `Q${position}`;
  return QUARTER_LABELS[position - 1];
}

// ---------------------------------------------------------------------
// extractPositionFromIso — parse the wide-format PeriodIso labels emitted
// by server/lib/wideFormat/periodVocabulary.ts. Supports:
//   "2024-03"      → {year: 2024, month: 3}
//   "2024-Q3"      → {year: 2024, quarter: 3}
//   "FY2024-Q1"    → {year: 2024, quarter: 1}
//   "2024-W12"     → null  (weekly — not a seasonality grain we support)
//   "MAT-2024-12"  → null  (rolling-window aggregate — not a position)
//   "L12M"         → null  (rolling — not a position)

export interface IsoPosition {
  year: number;
  position: number;
  grain: SeasonalityGrain;
}

export function extractPositionFromIso(iso: string): IsoPosition | null {
  if (typeof iso !== "string") return null;
  const t = iso.trim();
  if (!t) return null;

  // YYYY-MM (monthly bucket).
  let m = t.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return { year, position: month, grain: "month" };
    return null;
  }

  // YYYY-Q[1-4] (quarterly bucket).
  m = t.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    return { year: Number(m[1]), position: Number(m[2]), grain: "quarter" };
  }

  // FYYYYY-Q[1-4] (fiscal-year quarterly).
  m = t.match(/^FY(\d{4})-Q([1-4])$/);
  if (m) {
    return { year: Number(m[1]), position: Number(m[2]), grain: "quarter" };
  }

  // FYYYYY (fiscal year, no quarter) → no position to extract for seasonality.
  // Plain YYYY → no position. YYYY-Hn → not supported (only 2 buckets).
  // Rolling / MAT / YTD / L\\d+M etc → no position.
  return null;
}

// ---------------------------------------------------------------------
// computeSeasonalityIndex — given (year, position, value) triples,
// produce one row per position with mean, count, and index.

export interface SeasonalityRow {
  position: number;
  label: string;
  mean: number;
  count: number;
  /** mean_at_position / overall_mean_across_positions; 1.0 = average. */
  index: number;
  /** observations per year on average (for sparse-data flagging). */
  observationsPerYear: number;
  /** number of distinct years that have any observation at this position. */
  yearsObserved: number;
}

export interface SeasonalityInput {
  year: number;
  position: number;
  value: number;
}

export function computeSeasonalityIndex(
  rows: SeasonalityInput[],
  grain: SeasonalityGrain
): SeasonalityRow[] {
  const positions = grain === "month" ? 12 : 4;
  // Bucket: position → {sum, count, yearSet}
  const buckets = new Map<
    number,
    { sum: number; count: number; years: Set<number> }
  >();
  for (let p = 1; p <= positions; p++) {
    buckets.set(p, { sum: 0, count: 0, years: new Set() });
  }
  let totalSum = 0;
  let totalCount = 0;
  for (const r of rows) {
    if (
      r.position < 1 ||
      r.position > positions ||
      !Number.isFinite(r.value)
    ) {
      continue;
    }
    const b = buckets.get(r.position)!;
    b.sum += r.value;
    b.count += 1;
    b.years.add(r.year);
    totalSum += r.value;
    totalCount += 1;
  }
  if (totalCount === 0) return [];
  // Overall mean = average of position-means (weighted by count). We use
  // simple sum/count (volume-weighted) so a sparse position doesn't pull
  // the baseline. For the index, use the average of position-means so the
  // index is centred on 1.0 when seasonality is flat.
  const positionMeans: number[] = [];
  for (let p = 1; p <= positions; p++) {
    const b = buckets.get(p)!;
    if (b.count > 0) positionMeans.push(b.sum / b.count);
  }
  const baseline =
    positionMeans.length > 0
      ? positionMeans.reduce((a, b) => a + b, 0) / positionMeans.length
      : 0;
  const out: SeasonalityRow[] = [];
  for (let p = 1; p <= positions; p++) {
    const b = buckets.get(p)!;
    const mean = b.count > 0 ? b.sum / b.count : 0;
    const index = baseline > 0 ? mean / baseline : 1;
    out.push({
      position: p,
      label: positionLabel(grain, p),
      mean,
      count: b.count,
      index,
      yearsObserved: b.years.size,
      observationsPerYear: b.years.size > 0 ? b.count / b.years.size : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// computePeakConsistency — for each year, rank positions by value. For
// each position, count the fraction of years in which it appeared in the
// top K. The user's complaint is that "Oct/Nov/Dec peak EVERY year" was
// missed — this is the function that surfaces it.

export interface PeakConsistencyRow {
  position: number;
  label: string;
  /** Years in which this position appeared in the per-year top K. */
  yearsHit: number[];
  /** yearsHit.length / totalYears. */
  fractionInTopK: number;
}

export interface PeakConsistencyOutput {
  topK: number;
  totalYears: number;
  rows: PeakConsistencyRow[];
  /** Positions whose fractionInTopK ≥ consistencyThreshold; the "consistent peaks". */
  consistentPeaks: PeakConsistencyRow[];
}

export function computePeakConsistency(
  rows: SeasonalityInput[],
  grain: SeasonalityGrain,
  topK = 3,
  consistencyThreshold = 0.6
): PeakConsistencyOutput {
  const positions = grain === "month" ? 12 : 4;
  // Group by year → position → value (sum within (year, position) in case
  // the caller passed multiple rows for the same cell; defensive).
  const byYear = new Map<number, Map<number, number>>();
  for (const r of rows) {
    if (
      r.position < 1 ||
      r.position > positions ||
      !Number.isFinite(r.value)
    ) {
      continue;
    }
    let y = byYear.get(r.year);
    if (!y) {
      y = new Map();
      byYear.set(r.year, y);
    }
    y.set(r.position, (y.get(r.position) ?? 0) + r.value);
  }
  const allYears = [...byYear.keys()].sort();
  // For each year, rank positions desc by value, take top K.
  const yearTopK = new Map<number, Set<number>>();
  for (const year of allYears) {
    const yearMap = byYear.get(year)!;
    const ranked = [...yearMap.entries()]
      .filter(([, v]) => Number.isFinite(v))
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, topK))
      .map(([pos]) => pos);
    yearTopK.set(year, new Set(ranked));
  }
  // For each position, count years where it appeared in top K.
  const out: PeakConsistencyRow[] = [];
  for (let p = 1; p <= positions; p++) {
    const yearsHit: number[] = [];
    for (const year of allYears) {
      if (yearTopK.get(year)!.has(p)) yearsHit.push(year);
    }
    out.push({
      position: p,
      label: positionLabel(grain, p),
      yearsHit,
      fractionInTopK: allYears.length > 0 ? yearsHit.length / allYears.length : 0,
    });
  }
  out.sort((a, b) => b.fractionInTopK - a.fractionInTopK);
  return {
    topK,
    totalYears: allYears.length,
    rows: out,
    consistentPeaks: out.filter((r) => r.fractionInTopK >= consistencyThreshold),
  };
}

// ---------------------------------------------------------------------
// seasonalityStrength — classify based on (max_index − min_index). When
// indices are tightly clustered around 1.0 the dataset has no seasonal
// signal; when one position is 50 %+ above another there's a strong cycle.

export type SeasonalityStrengthTier = "strong" | "moderate" | "weak" | "none";

export interface StrengthOutput {
  tier: SeasonalityStrengthTier;
  range: number;
  topIndex: number;
  bottomIndex: number;
}

export function seasonalityStrength(
  index: SeasonalityRow[]
): StrengthOutput {
  if (index.length === 0) {
    return { tier: "none", range: 0, topIndex: 1, bottomIndex: 1 };
  }
  const indices = index
    .filter((r) => r.count > 0 && Number.isFinite(r.index))
    .map((r) => r.index);
  if (indices.length === 0) {
    return { tier: "none", range: 0, topIndex: 1, bottomIndex: 1 };
  }
  const top = Math.max(...indices);
  const bottom = Math.min(...indices);
  const range = top - bottom;
  const tier: SeasonalityStrengthTier =
    range >= 0.5 ? "strong" : range >= 0.2 ? "moderate" : range >= 0.05 ? "weak" : "none";
  return { tier, range, topIndex: top, bottomIndex: bottom };
}

// ---------------------------------------------------------------------
// summarizeSeasonality — produce the single-paragraph narrator-friendly
// summary that lands in the tool's `summary` field. Designed to drop
// directly into findings[].evidence by the narrator.

export function summarizeSeasonality(
  index: SeasonalityRow[],
  consistency: PeakConsistencyOutput,
  strength: StrengthOutput,
  grain: SeasonalityGrain
): string {
  if (consistency.totalYears < 2) {
    return `Insufficient data for seasonality analysis (need ≥2 years; got ${consistency.totalYears}).`;
  }
  if (strength.tier === "none") {
    return `No meaningful ${grain}-of-year seasonality detected across ${consistency.totalYears} year(s); position indices range only ${(strength.range * 100).toFixed(1)} pp.`;
  }
  // Pick the consistent peaks (already filtered ≥ threshold). Fall back
  // to the top by index when there are no consistent peaks (e.g. a strong
  // but year-shifting peak — rare on FMCG data).
  const peaks =
    consistency.consistentPeaks.length > 0
      ? consistency.consistentPeaks
      : consistency.rows.slice(0, consistency.topK);
  const peakLabels = peaks.map((p) => p.label).join("/");
  const topPeak = peaks[0];
  const topIndexRow = index.find((r) => r.position === topPeak.position);
  const aboveAvgPct =
    topIndexRow && topIndexRow.index > 0
      ? Math.round((topIndexRow.index - 1) * 100)
      : 0;
  const consistencyFrac = topPeak.fractionInTopK;
  const consistencyText = `${topPeak.yearsHit.length} of ${consistency.totalYears}`;
  const grainLabel = grain === "month" ? "month-of-year" : "quarter-of-year";
  const peakWindow =
    peaks.length === 1 ? topPeak.label : `${peakLabels} (${grain === "month" ? "months" : "quarters"})`;
  return `${strength.tier === "strong" ? "Strong" : strength.tier === "moderate" ? "Moderate" : "Weak"} ${grainLabel} seasonality across ${consistency.totalYears} year(s): ${peakWindow} consistently peaks (${consistencyText} years), with ${topPeak.label} averaging ${aboveAvgPct >= 0 ? "+" : ""}${aboveAvgPct}% vs the typical ${grain}.`;
}

// ---------------------------------------------------------------------
// chooseSeasonalityGrain — given temporal coverage, pick "month",
// "quarter", or refuse with null. Mirrors chooseAutoGrain in
// growth/periodShift.ts but for seasonality semantics.

export function chooseSeasonalityGrain(coverage: {
  distinctYears: number;
  distinctMonthsInOneYear?: number;
  distinctQuartersInOneYear?: number;
}): SeasonalityGrain | null {
  if (coverage.distinctYears < 2) return null;
  // Prefer monthly when at least 6 months are observed in any year (so the
  // index has 6+ non-zero buckets to compare).
  if ((coverage.distinctMonthsInOneYear ?? 0) >= 6) return "month";
  if ((coverage.distinctQuartersInOneYear ?? 0) >= 4) return "quarter";
  return null;
}
