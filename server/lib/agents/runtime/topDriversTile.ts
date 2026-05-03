/**
 * W6 · Top Drivers tile builder.
 *
 * For "what impacts X most" question shapes (driver_discovery), the auto-built
 * dashboard typically lists per-dimension breakdown charts but lacks a single
 * tile that *ranks the drivers* by their impact. This pure function takes a
 * list of (driverName, impactValue) pairs and emits a single bar `ChartSpec`
 * sorted by absolute impact, capped at 8 — to be inserted as the first chart
 * on the dashboard's All Artefacts sheet.
 *
 * The signal-source decision (correlation strength vs share-of-variance vs
 * normalised breakdown gap) is the caller's responsibility; this function is
 * just the deterministic chart-spec emitter.
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
