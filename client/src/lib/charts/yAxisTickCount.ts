/**
 * Density-aware Y-axis tick count.
 *
 * Two failure modes were producing the same bug:
 *   1. recharts `<YAxis>` without `tickCount` defaults to 5 — too few for
 *      modal-sized charts (~700px), with awkward fractional steps like 0.35
 *      for a [-0.25, 0.99] correlation domain.
 *   2. visx renderers hardcoded `numTicks={4|5|6|12}` literals with no
 *      relationship to the rendered height.
 *
 * Both libraries treat the count as a HINT to their nice-tick algorithm
 * (1, 2, 2.5, 5 × 10^k snapping). Giving them a better hint based on
 * available pixel height yields more labels at round values without
 * crowding.
 *
 * Constants tuned for an 11-12px axis label: ~52px between adjacent
 * labels keeps them legible without feeling sparse.
 */

export const MIN_Y_TICKS = 4;
export const MAX_Y_TICKS = 10;
export const PX_PER_Y_TICK = 52;
export const DEFAULT_Y_TICKS = 8;

/**
 * Density-based tick count.
 *
 * @param heightPx - Available pixel height of the chart's inner plot area.
 *   When omitted (recharts callers inside `<ResponsiveContainer>` can't
 *   easily measure), returns `DEFAULT_Y_TICKS` which is large enough to
 *   look good on typical card / modal sizes without overcrowding small
 *   tiles (recharts will internally clamp to nice steps).
 */
export function targetYTickCount(heightPx?: number): number {
  if (typeof heightPx !== 'number' || !Number.isFinite(heightPx) || heightPx <= 0) {
    return DEFAULT_Y_TICKS;
  }
  const raw = Math.round(heightPx / PX_PER_Y_TICK);
  return Math.max(MIN_Y_TICKS, Math.min(MAX_Y_TICKS, raw));
}
