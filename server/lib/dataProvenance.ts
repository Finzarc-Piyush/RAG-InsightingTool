/**
 * Wave C6 + C7 · row-level provenance + confidence intervals.
 *
 * Three responsibilities:
 *   1. Annotate sampled rows with `_meta.outlierFlags` so prompt rendering can
 *      mark them ("142 rows; 3 are outliers in 2+ dims") rather than letting
 *      the LLM cite a 99th-percentile row as typical.
 *   2. Attach `provenance` to magnitude findings: which row IDs / how many
 *      rows underpin the claim, so the narrator can cite "based on N rows".
 *   3. Compute 95% CIs on numeric magnitudes (mean, sum, percent change).
 *      Bootstrap when n < 30, analytical CLT otherwise.
 */
import type { NumericStats } from "./schemaIndex.js";

// ─── C6 · Outlier flagging on sampled rows ─────────────────────────────────

export interface OutlierMeta {
  outlierFlags: string[];
}

export type AnnotatedRow = Record<string, unknown> & { _meta?: OutlierMeta };

export function annotateOutliers(
  rows: ReadonlyArray<Record<string, unknown>>,
  numericStats: Record<string, NumericStats>
): AnnotatedRow[] {
  const out: AnnotatedRow[] = [];
  for (const r of rows) {
    const flagged: string[] = [];
    for (const [col, stats] of Object.entries(numericStats)) {
      const v = toNumber(r[col]);
      if (v === null) continue;
      if (v < stats.outlierLow || v > stats.outlierHigh) flagged.push(col);
    }
    out.push(flagged.length > 0 ? { ...r, _meta: { outlierFlags: flagged } } : (r as AnnotatedRow));
  }
  return out;
}

// ─── C6 · Row-level provenance for findings ────────────────────────────────

export interface MagnitudeProvenance {
  rowCount: number;
  /** Sample of row references — small enough to embed in the finding. */
  sampleRows: Record<string, unknown>[];
  /** Filter spec under which the magnitude was computed. */
  filter?: Record<string, unknown>;
}

export function buildProvenance(
  filteredRows: ReadonlyArray<Record<string, unknown>>,
  filter?: Record<string, unknown>,
  sampleSize = 5
): MagnitudeProvenance {
  return {
    rowCount: filteredRows.length,
    sampleRows: filteredRows.slice(0, Math.max(0, sampleSize)) as Record<string, unknown>[],
    filter,
  };
}

// ─── C7 · Confidence intervals ─────────────────────────────────────────────

export type CI = [low: number, high: number];

/**
 * Analytical 95% CI for a sample mean (CLT). Best when n ≥ 30 and the
 * distribution is reasonably symmetric.
 */
export function meanCI(values: number[], confidence = 0.95): CI | undefined {
  const n = values.length;
  if (n < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const z = confidence === 0.95 ? 1.96 : confidence === 0.99 ? 2.576 : 1.645;
  return [mean - z * se, mean + z * se];
}

/**
 * Bootstrap 95% CI for any statistic over a sample. Default 1000 resamples.
 * Use when the distribution is skewed or the statistic isn't a simple mean
 * (e.g. percent change between two cohorts).
 */
export function bootstrapCI(
  sample: number[],
  statistic: (s: number[]) => number,
  resamples = 1000,
  confidence = 0.95
): CI | undefined {
  const n = sample.length;
  if (n < 5) return undefined;
  const stats: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const resample: number[] = [];
    for (let j = 0; j < n; j++) {
      resample.push(sample[(Math.random() * n) | 0]);
    }
    stats.push(statistic(resample));
  }
  stats.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const low = stats[Math.floor((alpha / 2) * resamples)];
  const high = stats[Math.floor((1 - alpha / 2) * resamples)];
  return [low, high];
}

/**
 * 95% CI for percent change between two paired samples (e.g. before/after).
 * Bootstrap-based; n_paired ≥ 5.
 */
export function percentChangeCI(
  before: number[],
  after: number[],
  resamples = 1000
): CI | undefined {
  if (before.length !== after.length) return undefined;
  const n = before.length;
  if (n < 5) return undefined;
  const computePct = (idxs: number[]): number => {
    let sumBefore = 0;
    let sumAfter = 0;
    for (const i of idxs) {
      sumBefore += before[i];
      sumAfter += after[i];
    }
    if (sumBefore === 0) return 0;
    return ((sumAfter - sumBefore) / Math.abs(sumBefore)) * 100;
  };
  const stats: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const idxs: number[] = [];
    for (let j = 0; j < n; j++) idxs.push((Math.random() * n) | 0);
    stats.push(computePct(idxs));
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * resamples)], stats[Math.floor(0.975 * resamples)]];
}

/**
 * Pearson correlation 95% CI via Fisher z-transform.
 */
export function correlationCI(r: number, n: number, confidence = 0.95): CI | undefined {
  if (n < 4 || Math.abs(r) > 0.9999) return undefined;
  const z = confidence === 0.95 ? 1.96 : 2.576;
  const fisherZ = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const lowZ = fisherZ - z * se;
  const highZ = fisherZ + z * se;
  const back = (zi: number) => (Math.exp(2 * zi) - 1) / (Math.exp(2 * zi) + 1);
  return [back(lowZ), back(highZ)];
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}
