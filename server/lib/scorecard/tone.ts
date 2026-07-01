import type { MetricPolarity } from "../financeMetricAuthority.js";

/**
 * Wave W2 (data-bound cards) · the scorecard TONE authority. Turns a change
 * (period-over-period delta, or value-vs-target) into a colour judgment that
 * is DIRECTION-AWARE: a metric's polarity (from `financeMetricAuthority`)
 * decides whether "up" means good or bad. A `neutral`-polarity metric never
 * gets a good/bad colour — only the raw arrow — so we never mislabel a
 * directionless move (e.g. a mix %) as improvement or decline.
 */

export type ScorecardTone = "good" | "warn" | "bad" | "neutral";

/** |Δ| below this is treated as flat (noise) → neutral. */
export const DEFAULT_NEUTRAL_BAND_PCT = 0.01; // 1%
/** vs-target: within this fraction on the wrong side of target → warn (amber). */
export const DEFAULT_TARGET_WARN_BAND_PCT = 0.05; // 5%

/**
 * Period-over-period tone from a fractional delta (e.g. +0.083 = +8.3%).
 * Null/undefined/non-finite delta (no comparison) → neutral.
 */
export function resolveTone(
  deltaPct: number | null | undefined,
  polarity: MetricPolarity,
  opts?: { neutralBandPct?: number }
): ScorecardTone {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return "neutral";
  if (polarity === "neutral") return "neutral";
  const band = opts?.neutralBandPct ?? DEFAULT_NEUTRAL_BAND_PCT;
  if (Math.abs(deltaPct) < band) return "neutral";
  // Improving when the move's sign agrees with the polarity's "good" direction.
  const improving = deltaPct > 0 === (polarity === "higher_better");
  return improving ? "good" : "bad";
}

/**
 * vs-target tone: meets/beats target → good; misses within the warn band →
 * warn (amber); misses beyond it → bad. `warn` only ever comes from this path.
 */
export function resolveToneVsTarget(
  value: number | null | undefined,
  target: number | null | undefined,
  polarity: MetricPolarity,
  opts?: { warnBandPct?: number }
): ScorecardTone {
  if (
    value == null ||
    target == null ||
    !Number.isFinite(value) ||
    !Number.isFinite(target) ||
    target === 0
  ) {
    return "neutral";
  }
  if (polarity === "neutral") return "neutral";
  // + = value is above target; whether that's good depends on polarity.
  const gapPct = (value - target) / Math.abs(target);
  const meets = gapPct >= 0 === (polarity === "higher_better");
  if (meets) return "good";
  const warnBand = opts?.warnBandPct ?? DEFAULT_TARGET_WARN_BAND_PCT;
  return Math.abs(gapPct) <= warnBand ? "warn" : "bad";
}
