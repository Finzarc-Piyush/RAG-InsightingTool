// WGR4 · Pure OLS linear-trend helper for intra-span trend analysis.
//
// Fits y = intercept + slope·x over x = 0..n-1 (the row index of an
// ordered series) and returns slope + pseudo-R² (trend strength). Used by
// compute_growth's "trend" mode to describe a within-window trajectory
// (rising / falling / flat) when there is no calendar prior period to pair
// against.
//
// Deliberately separate from the private `linearFit` in
// ../forecasting/forecastSeries.ts: that one is unexported, carries a
// residuals array we don't need, and lives behind a ≥4-point guard that is
// wrong for a 2-point trend. This helper is grain-agnostic and handles the
// 0/1/2-point and all-equal edge cases explicitly.

export interface LinearTrend {
  slope: number;
  intercept: number;
  r2: number;
}

/**
 * Ordinary least-squares fit of values against their index 0..n-1.
 *   - n === 0        → { slope: 0, intercept: 0, r2: 0 }
 *   - n === 1        → { slope: 0, intercept: values[0], r2: 0 }
 *   - all-equal (ssTot === 0) → slope 0, r2 0 (flat)
 * R² is clamped to [0, 1].
 */
export function linearTrend(values: number[]): LinearTrend {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: values[0]!, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;
  const slope = denom === 0 ? 0 : (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;

  // R² = 1 - SS_res / SS_tot.
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yHat = intercept + slope * i;
    ssRes += (values[i]! - yHat) ** 2;
    ssTot += (values[i]! - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2: Math.max(0, Math.min(1, r2)) };
}
