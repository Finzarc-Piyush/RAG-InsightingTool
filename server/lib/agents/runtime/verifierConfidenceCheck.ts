/**
 * Wave WV1 · verifier-side confidence overclaim detector.
 *
 * Pure helper that compares the narrator's claimed confidence on its
 * `magnitudes` / `implications` fields against the deterministic WQ1 tiers
 * derived from blackboard findings. Surfaces overclaim flags the verifier
 * can use to ask for a `revise_narrative` re-run when the narrator inflated
 * confidence beyond what the evidence supports.
 *
 * Pairs with WW1 (planner directive) + WW2 (per-finding tier in narrator
 * user prompt). Without WV1 the narrator's tier choice is unaudited — the
 * directive nudges but doesn't enforce. WV1 closes the loop on the
 * deterministic-floor design.
 *
 * Aggregate-level check, not per-finding matching. Narrator magnitudes
 * carry `{label, value, confidence?}` with no findingId reference, so
 * pairing each magnitude to a specific finding requires fuzzy matching
 * that drifts. Counting tiers across the whole output vs the whole
 * blackboard is robust and surfaces the actual failure mode (narrator
 * marked 5/5 magnitudes "high" when the blackboard's evidence supports 0).
 */

import type { NarratorOutput } from "./narratorAgent.js";
import { tierBlackboardFindings } from "./narratorHintsBlock.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import type { ConfidenceTier } from "./scaleNarrativeByConfidence.js";

export type OverclaimSeverity = "info" | "warning" | "block";

export interface ConfidenceTierCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface ConfidenceOverclaimFlag {
  kind:
    | "narrator_high_exceeds_blackboard_high"
    | "narrator_all_high_with_low_in_blackboard"
    | "narrator_low_exceeds_blackboard_lowish";
  severity: OverclaimSeverity;
  /** Numeric magnitudes of the mismatch — `(narratorN, blackboardN)`. */
  numbers: { narrator: number; blackboard: number };
  /** Human-readable message suitable for verifier `revise_narrative` issues. */
  message: string;
}

export interface ConfidenceOverclaimReport {
  claimed: ConfidenceTierCounts;
  actual: ConfidenceTierCounts;
  flags: ConfidenceOverclaimFlag[];
  /** True iff at least one flag has severity `warning` or `block`. The
   *  verifier should request `revise_narrative` when this is true. */
  shouldRevise: boolean;
}

/** Count narrator-claimed tiers across magnitudes + implications. */
function countClaimedTiers(
  output: NarratorOutput,
): ConfidenceTierCounts {
  const counts: ConfidenceTierCounts = { high: 0, medium: 0, low: 0, total: 0 };
  const items: { confidence?: ConfidenceTier }[] = [];
  if (output.magnitudes) items.push(...output.magnitudes);
  if (output.implications) items.push(...output.implications);
  for (const item of items) {
    counts.total += 1;
    if (item.confidence === "high") counts.high += 1;
    else if (item.confidence === "low") counts.low += 1;
    else counts.medium += 1; // unset / "medium" both fall here
  }
  return counts;
}

/** Count actual tiers across blackboard findings via WQ1. */
function countActualTiers(blackboard: AnalyticalBlackboard): ConfidenceTierCounts {
  const tiered = tierBlackboardFindings(blackboard);
  const counts: ConfidenceTierCounts = { high: 0, medium: 0, low: 0, total: tiered.length };
  for (const t of tiered) {
    if (t.assessment.tier === "high") counts.high += 1;
    else if (t.assessment.tier === "low") counts.low += 1;
    else counts.medium += 1;
  }
  return counts;
}

/**
 * Pure detector. Compares aggregate tier counts and emits flags when the
 * narrator inflated confidence beyond what the deterministic classifier
 * supports.
 *
 * Decision rules:
 *  1. `narrator_high_exceeds_blackboard_high` (warning) — narrator claimed
 *     more `high` than the blackboard supports. Always surfaces when at
 *     least one finding exists; suppressed when the blackboard has zero
 *     findings (some narrators run on observations alone — out of WQ1 scope).
 *  2. `narrator_all_high_with_low_in_blackboard` (block) — narrator marked
 *     EVERY magnitude `high` while the blackboard has ≥1 `low` finding.
 *     The strongest overclaim signal — the narrator silently swept the
 *     uncertainty away.
 *  3. `narrator_low_exceeds_blackboard_lowish` (info) — narrator hedged
 *     more aggressively than the evidence requires. Not a quality
 *     regression, just an over-hedge — useful as a nudge but never a
 *     `revise_narrative` blocker.
 */
export function detectConfidenceOverclaims(
  output: NarratorOutput,
  blackboard: AnalyticalBlackboard,
): ConfidenceOverclaimReport {
  const claimed = countClaimedTiers(output);
  const actual = countActualTiers(blackboard);
  const flags: ConfidenceOverclaimFlag[] = [];

  // Rule 1 — narrator high exceeds blackboard high.
  if (actual.total > 0 && claimed.high > actual.high) {
    flags.push({
      kind: "narrator_high_exceeds_blackboard_high",
      severity: "warning",
      numbers: { narrator: claimed.high, blackboard: actual.high },
      message: `Narrator marked ${claimed.high} magnitudes/implications as high-confidence, but only ${actual.high} of ${actual.total} blackboard findings clear the WQ1 high threshold (n ≥ 30, p ≤ 0.05, CI ≤ 30%, R² ≥ 0.5). Downgrade the surplus to medium and weave the hedge phrase into the prose.`,
    });
  }

  // Rule 2 — strongest signal: narrator marked everything high while the
  // blackboard carries any low finding.
  if (
    claimed.total > 0 &&
    claimed.high === claimed.total &&
    actual.low > 0
  ) {
    flags.push({
      kind: "narrator_all_high_with_low_in_blackboard",
      severity: "block",
      numbers: { narrator: claimed.high, blackboard: actual.low },
      message: `Narrator marked every magnitude as high-confidence, but ${actual.low} blackboard finding(s) graded LOW by WQ1 (e.g. n < 10, p > 0.15, CI > 60%, R² < 0.2). The narrative is overstating certainty — at least one magnitude/implication must surface as low with the canonical hedge.`,
    });
  }

  // Rule 3 — over-hedge. Informational only.
  const blackboardLowish = actual.low + actual.medium;
  if (actual.total > 0 && claimed.low > blackboardLowish) {
    flags.push({
      kind: "narrator_low_exceeds_blackboard_lowish",
      severity: "info",
      numbers: { narrator: claimed.low, blackboard: blackboardLowish },
      message: `Narrator hedged ${claimed.low} magnitudes/implications as low-confidence, but only ${blackboardLowish} of ${actual.total} blackboard findings require hedging (the rest are high-confidence). Consider unhedging the over-cautious ones.`,
    });
  }

  const shouldRevise = flags.some(
    (f) => f.severity === "warning" || f.severity === "block",
  );
  return { claimed, actual, flags, shouldRevise };
}
