/**
 * Wave F1 · Pure-Node forecasting helpers. Lives outside the Python-service
 * boundary so callers (the agent tool, narrator follow-ups) don't pay a
 * round-trip. Trades sophistication for simplicity:
 *
 *   - Linear trend regression on the historical series (least squares).
 *   - Optional seasonal-naive add-on: detect a seasonal period (4, 12,
 *     52, 7), subtract the per-position seasonal mean from the
 *     residual, project the trend, then add back the seasonal pattern.
 *   - Bootstrap confidence intervals via residual std × 1.96 (≈95% CI)
 *     scaled by sqrt(horizon-step) so uncertainty widens with the
 *     forecast horizon (classic naive-error-band behaviour).
 *
 * NOT meant to replace a real ARIMA/Prophet model — this is "good enough
 * to answer 'what does next quarter look like'". Users who need
 * production-grade forecasts can upgrade to a Python-service
 * statsmodels backend later (the contract surface stays identical:
 * `forecastSeries(input) → ForecastResult`).
 */

export interface SeriesPoint {
  /** Position in the series — typically a YYYY-MM or quarter index. */
  label: string;
  /** Observed value at that position. NaN/null treated as missing and skipped. */
  value: number | null;
}

export type ForecastSeasonality = "auto" | "none" | 4 | 7 | 12 | 52;

export interface ForecastInput {
  history: SeriesPoint[];
  horizon: number; // number of future periods to predict
  seasonality?: ForecastSeasonality;
}

export interface ForecastPoint {
  label: string;
  pointForecast: number;
  lowerCI: number;
  upperCI: number;
}

export interface ForecastResult {
  ok: true;
  forecast: ForecastPoint[];
  method: "linear_trend" | "linear_trend_plus_seasonal";
  /** Detected seasonal period (only set when method includes seasonal). */
  seasonalPeriod?: number;
  /** Pseudo-R² of the trend fit (0–1; higher = trend more explanatory). */
  trendR2: number;
  /** Std-dev of the residuals (per-period spread of model error). */
  residualStd: number;
}

export type ForecastFailure = { ok: false; error: string };

const Z_95 = 1.96;

/**
 * Strip null/NaN values and return the dense series with ORIGINAL labels
 * preserved at the same indices as the cleaned values (we lose the missing
 * labels — by design; forecasting with gappy data is its own can of worms).
 */
function cleanSeries(history: SeriesPoint[]): {
  values: number[];
  labels: string[];
} {
  const values: number[] = [];
  const labels: string[] = [];
  for (const pt of history) {
    if (pt.value == null) continue;
    if (typeof pt.value === "number" && Number.isFinite(pt.value)) {
      values.push(pt.value);
      labels.push(pt.label);
    }
  }
  return { values, labels };
}

/**
 * Ordinary least-squares fit: y = a + b*x, where x is the row index (0..N-1).
 * Returns the intercept, slope, and pseudo-R².
 */
function linearFit(values: number[]): {
  intercept: number;
  slope: number;
  r2: number;
  residuals: number[];
} {
  const n = values.length;
  if (n < 2) {
    return {
      intercept: values[0] ?? 0,
      slope: 0,
      r2: 0,
      residuals: values.length ? [0] : [],
    };
  }
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
  // R² = 1 - SS_res / SS_tot
  let ssRes = 0;
  let ssTot = 0;
  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    const yHat = intercept + slope * i;
    const resid = values[i]! - yHat;
    residuals.push(resid);
    ssRes += resid * resid;
    ssTot += (values[i]! - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { intercept, slope, r2: Math.max(0, Math.min(1, r2)), residuals };
}

/**
 * Sample-stddev of an array (Bessel-corrected). Returns 0 for arrays
 * shorter than 2.
 */
function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * Pick a seasonal period heuristically. Returns null when the series is
 * too short for ANY pooled-mean estimate to be meaningful.
 *
 * Heuristic: prefer the period whose seasonal-detrended residual std is
 * SMALLEST relative to the trend residual std (the seasonal pattern
 * explains additional variance). Only considers 4 / 7 / 12 / 52.
 */
function detectSeasonalPeriod(
  values: number[],
  trendResiduals: number[]
): number | null {
  const N = values.length;
  // Need at least 2 full cycles for the candidate period.
  const candidates = [4, 7, 12, 52].filter((p) => N >= p * 2);
  if (candidates.length === 0) return null;
  const baseStd = sampleStd(trendResiduals);
  if (baseStd === 0) return null;
  let bestPeriod: number | null = null;
  let bestImprovement = 0.05; // require ≥ 5% residual-std reduction
  for (const period of candidates) {
    // Pool residuals by position (i % period); compute the per-position
    // mean. Subtract it from each residual. If the result's std is
    // materially smaller than baseStd, this period explains real
    // seasonal variance.
    const buckets: number[][] = Array.from({ length: period }, () => []);
    for (let i = 0; i < trendResiduals.length; i++) {
      buckets[i % period]!.push(trendResiduals[i]!);
    }
    const positionMeans = buckets.map(
      (b) => b.reduce((a, v) => a + v, 0) / Math.max(1, b.length)
    );
    const detrended = trendResiduals.map(
      (r, i) => r - positionMeans[i % period]!
    );
    const newStd = sampleStd(detrended);
    const improvement = (baseStd - newStd) / baseStd;
    if (improvement > bestImprovement) {
      bestImprovement = improvement;
      bestPeriod = period;
    }
  }
  return bestPeriod;
}

/**
 * Wave F1 · Forecast a series `horizon` periods into the future.
 * Returns either a successful ForecastResult or a failure with a
 * descriptive error string. Never throws — caller decides whether to
 * surface the failure or fall back.
 */
export function forecastSeries(
  input: ForecastInput
): ForecastResult | ForecastFailure {
  if (!Array.isArray(input.history)) {
    return { ok: false, error: "history must be an array" };
  }
  if (typeof input.horizon !== "number" || input.horizon < 1 || input.horizon > 120) {
    return {
      ok: false,
      error: "horizon must be a positive integer ≤ 120",
    };
  }
  const { values, labels } = cleanSeries(input.history);
  if (values.length < 4) {
    return {
      ok: false,
      error: `need at least 4 historical observations; got ${values.length}`,
    };
  }

  const { intercept, slope, r2, residuals } = linearFit(values);
  const residualStd = sampleStd(residuals);

  // Seasonality detection.
  let seasonalPeriod: number | null = null;
  let positionMeans: number[] | null = null;
  if (input.seasonality !== "none") {
    if (
      typeof input.seasonality === "number" &&
      [4, 7, 12, 52].includes(input.seasonality)
    ) {
      const p = input.seasonality;
      if (values.length >= p * 2) {
        seasonalPeriod = p;
      }
    } else {
      // "auto" or undefined
      seasonalPeriod = detectSeasonalPeriod(values, residuals);
    }
    if (seasonalPeriod != null) {
      const period = seasonalPeriod;
      const buckets: number[][] = Array.from({ length: period }, () => []);
      for (let i = 0; i < residuals.length; i++) {
        buckets[i % period]!.push(residuals[i]!);
      }
      positionMeans = buckets.map((b) =>
        b.length === 0 ? 0 : b.reduce((a, v) => a + v, 0) / b.length
      );
    }
  }

  // Build forecast points.
  const forecast: ForecastPoint[] = [];
  const lastLabel = labels[labels.length - 1] ?? "";
  for (let h = 1; h <= input.horizon; h++) {
    const i = values.length + (h - 1); // forecast index
    let yHat = intercept + slope * i;
    if (positionMeans && seasonalPeriod) {
      yHat += positionMeans[i % seasonalPeriod] ?? 0;
    }
    // CI widens with sqrt(h) — classic naive widening band. Bounded so
    // the band doesn't go totally insane at h=120.
    const ciWidth = Z_95 * residualStd * Math.sqrt(h);
    forecast.push({
      label: `${lastLabel}+${h}`,
      pointForecast: yHat,
      lowerCI: yHat - ciWidth,
      upperCI: yHat + ciWidth,
    });
  }

  return {
    ok: true,
    forecast,
    method:
      seasonalPeriod != null
        ? "linear_trend_plus_seasonal"
        : "linear_trend",
    ...(seasonalPeriod != null ? { seasonalPeriod } : {}),
    trendR2: r2,
    residualStd,
  };
}
