/**
 * ============================================================================
 * clampNarratorConfidence.ts — deterministically down-rank overclaimed labels
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The final verifier's `detectConfidenceOverclaims` (verifierConfidenceCheck.ts)
 *   detects when the narrator labelled more magnitudes/implications `high`-confidence
 *   than the deterministic blackboard classifier supports. Under the single-flow
 *   policy (CLAUDE.md invariant #6) the verifier's fix — a narrative *rewrite* — is
 *   suppressed, so historically the inflated label shipped to the user uncorrected
 *   (a wrong "HIGH" badge on the answer card).
 *
 *   This helper is the deterministic, no-LLM correction that closes that gap. It
 *   does NOT touch prose (so it stays within single-flow: no narrative
 *   regeneration, no planner override) — it only clamps the STRUCTURED
 *   `confidence` field on the shipped magnitudes/implications to what the
 *   blackboard actually supports.
 *
 * THE RULE (aggregate, matching the detector's "downgrade the surplus")
 *   - Only acts when `report.shouldRevise` is true.
 *   - Walks items in a stable order (magnitudes first, then implications) and
 *     keeps at most `report.actual.high` items at `high`; every further `high`
 *     is downgraded to `medium`.
 *   - Block case (`narrator_all_high_with_low_in_blackboard`): the blackboard
 *     carries a LOW finding but nothing surfaced low — force the last item to
 *     `low` so at least one hedge is visible (mirrors the detector's message).
 *   - Pure: never mutates inputs; returns fresh arrays only when something
 *     changed (identity preserved otherwise for cheap equality).
 */
import type { ConfidenceOverclaimReport } from "./verifierConfidenceCheck.js";
import type { ConfidenceTier } from "./scaleNarrativeByConfidence.js";

/** Any narrator item that carries an optional confidence tier. */
interface HasConfidence {
  confidence?: ConfidenceTier;
}

export interface ClampConfidenceResult<M extends HasConfidence, I extends HasConfidence> {
  magnitudes: M[] | undefined;
  implications: I[] | undefined;
  /** True when at least one label was changed. */
  changed: boolean;
  /** How many `high` labels were downgraded to `medium`. */
  downgradedHigh: number;
  /** True when the block rule forced one item to `low`. */
  forcedLow: boolean;
}

/**
 * Clamp magnitude/implication confidence labels to the blackboard-supported
 * tiers per `report`. See file header for the rule. Generic so it works on both
 * the narrator's `magnitudeSchema[]` and the answer-envelope implications
 * without importing either concrete type.
 */
export function clampConfidenceToBlackboard<
  M extends HasConfidence,
  I extends HasConfidence,
>(
  magnitudes: M[] | undefined,
  implications: I[] | undefined,
  report: ConfidenceOverclaimReport,
): ClampConfidenceResult<M, I> {
  const unchanged: ClampConfidenceResult<M, I> = {
    magnitudes,
    implications,
    changed: false,
    downgradedHigh: 0,
    forcedLow: false,
  };
  if (!report.shouldRevise) return unchanged;

  const allowedHigh = Math.max(0, report.actual.high);
  const hasBlockFlag = report.flags.some(
    (f) => f.kind === "narrator_all_high_with_low_in_blackboard",
  );

  // Shallow-clone so inputs are never mutated (pure contract).
  const mags = magnitudes ? magnitudes.map((m) => ({ ...m })) : undefined;
  const imps = implications ? implications.map((i) => ({ ...i })) : undefined;

  // Ordered view across both arrays; entries are references into the clones
  // above, so mutating through `ordered` updates `mags` / `imps`.
  const ordered: HasConfidence[] = [...(mags ?? []), ...(imps ?? [])];

  let keptHigh = 0;
  let downgradedHigh = 0;
  for (const item of ordered) {
    if (item.confidence === "high") {
      if (keptHigh < allowedHigh) {
        keptHigh += 1;
      } else {
        item.confidence = "medium";
        downgradedHigh += 1;
      }
    }
  }

  let forcedLow = false;
  if (
    hasBlockFlag &&
    ordered.length > 0 &&
    !ordered.some((i) => i.confidence === "low")
  ) {
    ordered[ordered.length - 1]!.confidence = "low";
    forcedLow = true;
  }

  const changed = downgradedHigh > 0 || forcedLow;
  if (!changed) return unchanged;
  return { magnitudes: mags, implications: imps, changed, downgradedHigh, forcedLow };
}
