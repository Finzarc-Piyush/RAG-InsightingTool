/**
 * Shared layer-resolver utilities. WC5.x.
 *
 * Each renderer reads `spec.layers[]` and turns layer specs into
 * concrete drawing instructions (y-value for a reference line, fit
 * params for a trend line, etc.). This module owns the math; each
 * renderer owns the SVG render.
 */

import type { ChartLayer } from "@/shared/schema";
import { aggregate } from "./dataEngine";
import { asNumber, type Row } from "./encodingResolver";

export interface ResolvedReferenceLine {
  /** "x" or "y" axis. */
  on: "x" | "y";
  /** Concrete numeric value for the line. */
  value: number;
  label?: string;
  style?: {
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
  };
}

/**
 * Resolve a `reference-line` layer to an absolute numeric value.
 * Returns null when the symbolic value can't be computed (e.g.
 * 'target' without a target field, or empty data).
 */
export function resolveReferenceLine(
  layer: ChartLayer,
  fieldValues: number[],
  targetValue?: number,
): ResolvedReferenceLine | null {
  if (layer.type !== "reference-line") return null;
  let v: number;
  if (typeof layer.value === "number") {
    v = layer.value;
  } else if (layer.value === "mean") {
    v = aggregate(fieldValues, "mean");
  } else if (layer.value === "median") {
    v = aggregate(fieldValues, "median");
  } else if (layer.value === "target") {
    if (typeof targetValue !== "number") return null;
    v = targetValue;
  } else {
    return null;
  }
  if (!Number.isFinite(v)) return null;
  return { on: layer.on, value: v, label: layer.label, style: layer.style };
}

/**
 * Pick reference-line layers from a spec, resolved against y-values
 * (and optionally x-values) from the data.
 */
export function resolveReferenceLines(
  layers: ChartLayer[] | undefined,
  rows: Row[],
  yField: string | undefined,
  targetValue?: number,
): ResolvedReferenceLine[] {
  if (!layers || !yField) return [];
  const yValues = rows.map((r) => asNumber(r[yField]));
  return layers
    .filter((l): l is Extract<ChartLayer, { type: "reference-line" }> =>
      l.type === "reference-line",
    )
    .map((l) => resolveReferenceLine(l, yValues, targetValue))
    .filter((l): l is ResolvedReferenceLine => l !== null);
}

// ─────────────────────────────────────────────────────────────────
// Linear trend line (least-squares fit)
// ─────────────────────────────────────────────────────────────────

export interface TrendLineFit {
  m: number;
  b: number;
  r2: number;
  /** Endpoints in data-space [(xMin, yAtMin), (xMax, yAtMax)]. */
  endpoints: [{ x: number; y: number }, { x: number; y: number }];
  ci?: number;
}

export function fitLinearTrend(
  xs: number[],
  ys: number[],
  ci?: number,
): TrendLineFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const finite: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]!) && Number.isFinite(ys[i]!)) {
      finite.push([xs[i]!, ys[i]!]);
    }
  }
  if (finite.length < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
  for (const [x, y] of finite) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }
  const N = finite.length;
  const denom = N * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const m = (N * sumXY - sumX * sumY) / denom;
  const b = (sumY - m * sumX) / N;
  const ssTot = sumYY - (sumY * sumY) / N;
  let ssRes = 0;
  for (const [x, y] of finite) {
    const yp = m * x + b;
    ssRes += (y - yp) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const xMin = Math.min(...finite.map((p) => p[0]));
  const xMax = Math.max(...finite.map((p) => p[0]));
  return {
    m,
    b,
    r2,
    endpoints: [
      { x: xMin, y: m * xMin + b },
      { x: xMax, y: m * xMax + b },
    ],
    ci,
  };
}

export function pickTrendLayer(
  layers: ChartLayer[] | undefined,
): Extract<ChartLayer, { type: "trend" }> | null {
  if (!layers) return null;
  const found = layers.find(
    (l): l is Extract<ChartLayer, { type: "trend" }> => l.type === "trend",
  );
  return found ?? null;
}

// ─────────────────────────────────────────────────────────────────
// Forecast — linear projection forward by `horizon` periods.
// Returns the projected values plus a CI envelope (upper/lower).
// ─────────────────────────────────────────────────────────────────

export interface ForecastPoint {
  /** Sequential index from the *end* of the input series (1-based). */
  i: number;
  y: number;
  yLow: number;
  yHigh: number;
}

export function pickForecastLayer(
  layers: ChartLayer[] | undefined,
): Extract<ChartLayer, { type: "forecast" }> | null {
  if (!layers) return null;
  const found = layers.find(
    (l): l is Extract<ChartLayer, { type: "forecast" }> => l.type === "forecast",
  );
  return found ?? null;
}

export function forecastSeries(
  ys: number[],
  layer: Extract<ChartLayer, { type: "forecast" }>,
): ForecastPoint[] {
  const n = ys.length;
  if (n < 2) return [];
  const xs = ys.map((_, i) => i);
  const fit = fitLinearTrend(xs, ys);
  if (!fit) return [];
  // Residual stdev on training data for CI.
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const yp = fit.m * xs[i]! + fit.b;
    ss += (ys[i]! - yp) ** 2;
  }
  const sigma = Math.sqrt(ss / Math.max(1, n - 2));
  const z =
    layer.ci !== undefined
      ? // Use a tabulated z for common CI; fallback to 1.96 (~95%).
        layer.ci >= 0.99
        ? 2.576
        : layer.ci >= 0.95
          ? 1.96
          : layer.ci >= 0.9
            ? 1.645
            : layer.ci >= 0.8
              ? 1.282
              : 1
      : 1.96;
  const out: ForecastPoint[] = [];
  for (let h = 1; h <= layer.horizon; h++) {
    const idx = n - 1 + h;
    const y = fit.m * idx + fit.b;
    const halfWidth = z * sigma * Math.sqrt(1 + h / n); // widening band
    out.push({ i: h, y, yLow: y - halfWidth, yHigh: y + halfWidth });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Outliers — flag points beyond `threshold` standard deviations.
// ─────────────────────────────────────────────────────────────────

export interface OutlierPoint {
  index: number;
  value: number;
  zscore: number;
}

export function pickOutliersLayer(
  layers: ChartLayer[] | undefined,
): Extract<ChartLayer, { type: "outliers" }> | null {
  if (!layers) return null;
  const found = layers.find(
    (l): l is Extract<ChartLayer, { type: "outliers" }> => l.type === "outliers",
  );
  return found ?? null;
}

export function detectOutliers(
  ys: number[],
  threshold = 2,
): OutlierPoint[] {
  if (ys.length < 4) return [];
  let sum = 0;
  let cnt = 0;
  for (const v of ys) {
    if (Number.isFinite(v)) {
      sum += v;
      cnt += 1;
    }
  }
  if (cnt === 0) return [];
  const mean = sum / cnt;
  let sq = 0;
  for (const v of ys) {
    if (Number.isFinite(v)) sq += (v - mean) ** 2;
  }
  const std = Math.sqrt(sq / Math.max(1, cnt - 1));
  if (std === 0) return [];
  const out: OutlierPoint[] = [];
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i]!;
    if (!Number.isFinite(v)) continue;
    const z = (v - mean) / std;
    if (Math.abs(z) >= threshold) {
      out.push({ index: i, value: v, zscore: z });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Annotations
// ─────────────────────────────────────────────────────────────────

export function pickAnnotations(
  layers: ChartLayer[] | undefined,
): Extract<ChartLayer, { type: "annotation" }>[] {
  if (!layers) return [];
  return layers.filter(
    (l): l is Extract<ChartLayer, { type: "annotation" }> =>
      l.type === "annotation",
  );
}

// ─────────────────────────────────────────────────────────────────
// Comparison overlay — shift the series back by one period for a
// faded prior-period reference behind the active line.
// ─────────────────────────────────────────────────────────────────

export function pickComparisonLayer(
  layers: ChartLayer[] | undefined,
): Extract<ChartLayer, { type: "comparison" }> | null {
  if (!layers) return null;
  const found = layers.find(
    (l): l is Extract<ChartLayer, { type: "comparison" }> =>
      l.type === "comparison",
  );
  return found ?? null;
}

/**
 * Build a "prior-period" twin of a series by shifting indices back by
 * `lag`. The first `lag` positions become null (drawn as gaps in the
 * faded line). Lag defaults to half the series length, capped at 12.
 */
export function priorPeriodSeries<P extends { y: number }>(
  points: P[],
  lag?: number,
): Array<P | null> {
  if (points.length === 0) return [];
  const n = points.length;
  const k = Math.max(1, Math.min(lag ?? Math.floor(n / 2), 12, n - 1));
  const out: Array<P | null> = new Array(n).fill(null);
  for (let i = k; i < n; i++) {
    out[i] = { ...points[i - k]! };
  }
  return out;
}
