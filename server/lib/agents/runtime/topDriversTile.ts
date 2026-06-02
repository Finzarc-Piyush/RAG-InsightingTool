/**
 * ============================================================================
 * topDriversTile.ts — build a "Top drivers of X" ranked bar chart
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Takes a list of (driver name, impact value) pairs and produces one bar
 *   ChartSpec that ranks the drivers by how strongly they affect an outcome,
 *   sorted by absolute impact and capped at 8 bars. A "ChartSpec" is the
 *   declarative description of a chart (type, axes, data) the client renders.
 *
 * WHY IT MATTERS
 *   For "what impacts X the most?" questions, the auto-built dashboard usually
 *   has per-dimension breakdown charts but no single tile that ranks the drivers
 *   head-to-head. This fills that gap as the lead chart on the dashboard.
 *
 * KEY PIECES
 *   - DriverImpact / BuildTopDriversTileArgs — input shapes.
 *   - buildTopDriversTile(args) — returns the ChartSpec, or null when the inputs
 *     don't meet the contract (< 2 valid drivers, non-finite impacts, etc.).
 *
 * HOW IT CONNECTS
 *   ChartSpec comes from shared/schema.ts. The caller decides which signal feeds
 *   "impact" (correlation strength, share-of-variance, breakdown gap, ...);
 *   this is just the deterministic spec emitter. Pure function, no I/O.
 */
import type { ChartSpec } from "../../../shared/schema.js";

export interface DriverImpact {
  /** Display name of the driver dimension (e.g. "Region", "Channel"). */
  name: string;
  /** Magnitude of the driver's impact on the outcome (any non-negative
   *  scalar; will be sorted desc). Set to `Math.abs(...)` upstream when
   *  using signed correlation coefficients. */
  impact: number;
  /** Optional source tag — surfaces in the bar's tooltip via x-axis label
   *  if needed (e.g. "correlation", "breakdown_top_share"). */
  source?: string;
}

export interface BuildTopDriversTileArgs {
  /** Outcome metric being explained (e.g. "Sales"). */
  outcomeName: string;
  /** Ranked or unranked driver impacts; this fn sorts internally. */
  drivers: DriverImpact[];
  /** Maximum drivers to display (default 8). */
  maxBars?: number;
  /** Title override; defaults to `Top drivers of <outcomeName>`. */
  title?: string;
}

/**
 * Emits the Top Drivers ChartSpec when the inputs satisfy the contract
 * (≥2 drivers, all impacts finite, outcomeName non-empty). Returns null
 * otherwise so the caller can skip the tile silently.
 */
export function buildTopDriversTile(
  args: BuildTopDriversTileArgs
): ChartSpec | null {
  const outcome = (args.outcomeName ?? "").trim();
  if (!outcome) return null;
  const cap = args.maxBars ?? 8;

  const cleaned = (args.drivers ?? [])
    .filter(
      (d) =>
        typeof d?.name === "string" &&
        d.name.trim().length > 0 &&
        Number.isFinite(d?.impact)
    )
    .map((d) => ({ name: d.name.trim(), impact: Math.abs(d.impact) }));

  if (cleaned.length < 2) return null;

  cleaned.sort((a, b) => b.impact - a.impact);
  const top = cleaned.slice(0, cap);

  const data = top.map((d) => ({ Driver: d.name, Impact: d.impact }));

  return {
    type: "bar",
    title: args.title ?? `Top drivers of ${outcome}`,
    x: "Driver",
    y: "Impact",
    xLabel: "Driver",
    yLabel: `Impact on ${outcome}`,
    aggregate: "none",
    data,
    _useAnalyticalDataOnly: true,
  };
}
