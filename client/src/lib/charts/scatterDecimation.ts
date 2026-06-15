// ────────────────────────────────────────────────────────────────────────
// scatterDecimation.ts — single source for scatter point-density capping
// ────────────────────────────────────────────────────────────────────────
// The point-density → max-points mapping and the every-Nth decimation were
// copy-pasted byte-for-byte into three scatter renderers (ChartRenderer,
// ChartModal, ChartOnlyModal). This module is the one authority; each
// component keeps only its own `type !== 'scatter'` guard and calls
// capScatterPoints. The decimation itself routes through dataEngine.sample,
// which already owns the stratified every-Nth algorithm.

import { sample, type Row } from "./dataEngine";

export type ScatterPointDensity = "low" | "medium" | "high" | "all";

/**
 * Max points to render for a given density preference. `all` means "no cap"
 * (returns the full length so callers short-circuit).
 */
export function maxRenderPointsForDensity(
  density: ScatterPointDensity,
  totalLength: number
): number {
  switch (density) {
    case "low":
      return 2000;
    case "medium":
      return 10000;
    case "high":
      return 20000;
    case "all":
      return totalLength;
    default:
      return 10000;
  }
}

/**
 * Cap scatter rows to the density preference, preserving distribution via
 * stratified (every-Nth) sampling. Returns the input untouched when already
 * under the cap or density is `all`.
 */
export function capScatterPoints<T extends Row>(
  rows: T[],
  density: ScatterPointDensity
): T[] {
  const maxN = maxRenderPointsForDensity(density, rows.length);
  if (rows.length <= maxN) return rows;
  return sample(rows, maxN) as T[];
}
