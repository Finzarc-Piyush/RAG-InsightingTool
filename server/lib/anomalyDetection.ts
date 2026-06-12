/**
 * Wave F2 · Pure-Node anomaly detection for time series and value samples.
 *
 * Two complementary methods:
 *   - **IQR**: an observation is anomalous if it lies outside
 *     `[Q1 - k·IQR, Q3 + k·IQR]`. k defaults to 1.5 (Tukey's classic).
 *     Robust to skewed distributions — does NOT assume normality.
 *   - **Z-score**: an observation is anomalous if `|value - mean| / std > k`.
 *     k defaults to 2.5. Sensitive to extreme outliers shifting the mean
 *     and inflating the std; use IQR when the data is skewed.
 *
 * "Both" runs both methods and flags the union. Each anomaly carries the
 * triggering method(s) so the caller can show ("flagged by IQR and z-score")
 * with appropriate confidence.
 */

export type AnomalyMethod = "iqr" | "zscore" | "both";

export interface AnomalyInput {
  values: number[];
  /** Optional labels (1:1 with values). Returned on each anomaly for the caller. */
  labels?: string[];
  method?: AnomalyMethod;
  /** IQR multiplier (default 1.5). */
  iqrK?: number;
  /** Z-score threshold (default 2.5). */
  zK?: number;
}

export interface Anomaly {
  index: number;
  label?: string;
  value: number;
  /** "high" → above upper bound; "low" → below lower bound. */
  direction: "high" | "low";
  /** Methods that flagged this observation. */
  flaggedBy: ("iqr" | "zscore")[];
  /** Standardised deviation from the median (IQR) or mean (z-score). */
  severity: number;
}

export interface AnomalyResult {
  ok: true;
  anomalies: Anomaly[];
  stats: {
    n: number;
    mean: number;
    median: number;
    std: number;
    q1: number;
    q3: number;
    iqr: number;
    upperBoundIqr: number;
    lowerBoundIqr: number;
  };
}

export type AnomalyFailure = { ok: false; error: string };

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function median(sorted: number[]): number {
  return quantile(sorted, 0.5);
}

function sampleStd(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const ss = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * Wave F2 · Detect anomalies in a numeric series. Returns the flagged
 * observations + descriptive stats so the caller can render a useful
 * "what's unusual" summary.
 */
export function detectAnomalies(
  input: AnomalyInput
): AnomalyResult | AnomalyFailure {
  const { values, labels } = input;
  if (!Array.isArray(values)) {
    return { ok: false, error: "values must be an array" };
  }
  // Filter to finite numerics and remember original indices.
  const indexed: Array<{ i: number; v: number; label?: string }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    indexed.push({ i, v, label: labels?.[i] });
  }
  if (indexed.length < 5) {
    return {
      ok: false,
      error: `need at least 5 finite observations; got ${indexed.length}`,
    };
  }
  const sorted = indexed.map((x) => x.v).slice().sort((a, b) => a - b);
  const med = median(sorted);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const mean = indexed.reduce((acc, x) => acc + x.v, 0) / indexed.length;
  const std = sampleStd(
    indexed.map((x) => x.v),
    mean
  );

  const iqrK = input.iqrK ?? 1.5;
  const zK = input.zK ?? 2.5;
  const upperIqr = q3 + iqrK * iqr;
  const lowerIqr = q1 - iqrK * iqr;
  const method = input.method ?? "both";

  const flagByIndex = new Map<number, Anomaly>();
  for (const { i, v, label } of indexed) {
    const flaggedBy: ("iqr" | "zscore")[] = [];
    const direction: "high" | "low" = v >= med ? "high" : "low";
    let severity = 0;

    if (method === "iqr" || method === "both") {
      if (v > upperIqr || v < lowerIqr) {
        flaggedBy.push("iqr");
        // Severity = distance beyond the bound in IQR units.
        const overshoot = v > upperIqr ? v - upperIqr : lowerIqr - v;
        severity = Math.max(severity, iqr === 0 ? 1 : overshoot / iqr + iqrK);
      }
    }
    if (method === "zscore" || method === "both") {
      if (std > 0 && Math.abs(v - mean) / std > zK) {
        flaggedBy.push("zscore");
        const z = Math.abs(v - mean) / std;
        severity = Math.max(severity, z);
      }
    }
    if (flaggedBy.length > 0) {
      flagByIndex.set(i, {
        index: i,
        label,
        value: v,
        direction,
        flaggedBy,
        severity,
      });
    }
  }
  const anomalies = [...flagByIndex.values()].sort((a, b) => b.severity - a.severity);
  return {
    ok: true,
    anomalies,
    stats: {
      n: indexed.length,
      mean,
      median: med,
      std,
      q1,
      q3,
      iqr,
      upperBoundIqr: upperIqr,
      lowerBoundIqr: lowerIqr,
    },
  };
}
