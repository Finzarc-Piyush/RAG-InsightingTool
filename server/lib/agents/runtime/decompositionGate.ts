/**
 * ============================================================================
 * decompositionGate.ts — should this turn be split into parallel arcs?
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A single read-only check the agent loop can call to ask: "should this
 *   question be broken into multiple parallel investigation 'arcs' instead of
 *   answered as one flow?" An "arc" is one independent line of analysis. It
 *   decides via a feature flag plus question-shape regex (and the analysis brief).
 *
 * WHY IT MATTERS
 *   The decomposition machinery (decomposeQuestion + investigation
 *   orchestrator) is live code but intentionally unwired from runAgentTurn by
 *   the single-flow policy (invariant #6). This gate is the controlled on-switch:
 *   default OFF, enabled per-deploy via AGENT_DECOMPOSITION_ENABLED=true.
 *
 * KEY PIECES
 *   - DecompositionDecision — { shouldDecompose, reason, optional suggestedArcs }.
 *   - shouldDecompose(opts) — true for multi-part conjunctions, compound (two
 *     "?") questions, why+do mixes, or comparison briefs with >= 2 dimensions.
 *
 * HOW IT CONNECTS
 *   Reads AnalysisBrief from shared/schema.ts. The reason string is surfaced in
 *   trace + SSE for visibility. Pure function, no I/O.
 */
import type { AnalysisBrief } from "../../../shared/schema.js";
import { isFlagOn } from "../../featureFlags.js";

export interface DecompositionDecision {
  /** Should the agent loop split into multiple arcs? */
  shouldDecompose: boolean;
  /** Reason for the decision; surfaced in trace and SSE for visibility. */
  reason: string;
  /** Suggested arc count (when decomposing). */
  suggestedArcs?: number;
}

const MULTI_PART_REGEX = /\b(and|then|also|plus)\b\s+(what|how|why|should|can|do)/i;
const COMPOUND_QUESTION_REGEX = /\?.*\?/; // two question marks
const WHY_AND_DO_REGEX = /\bwhy\b[\s\S]+?\b(should|do|recommend|action|next steps)/i;

export function shouldDecompose(opts: {
  question: string;
  brief?: AnalysisBrief;
}): DecompositionDecision {
  const enabled = isFlagOn("AGENT_DECOMPOSITION_ENABLED");
  if (!enabled) {
    return {
      shouldDecompose: false,
      reason: "AGENT_DECOMPOSITION_ENABLED=false (default).",
    };
  }
  const q = opts.question.trim();
  if (q.length < 30) {
    return {
      shouldDecompose: false,
      reason: "Question too short to benefit from decomposition.",
    };
  }
  if (MULTI_PART_REGEX.test(q)) {
    return {
      shouldDecompose: true,
      reason: "Question contains an explicit conjunction (and/then/also/plus + interrogative).",
      suggestedArcs: 2,
    };
  }
  if (COMPOUND_QUESTION_REGEX.test(q)) {
    return {
      shouldDecompose: true,
      reason: "Question contains multiple `?` markers.",
      suggestedArcs: 2,
    };
  }
  if (WHY_AND_DO_REGEX.test(q)) {
    return {
      shouldDecompose: true,
      reason: "Question mixes diagnostic ('why') with recommendation ('should/do/recommend').",
      suggestedArcs: 2,
    };
  }
  // Brief-driven shapes that benefit from decomposition.
  const shape = opts.brief?.questionShape;
  if (shape === "comparison" && (opts.brief?.segmentationDimensions?.length ?? 0) >= 2) {
    return {
      shouldDecompose: true,
      reason: "Comparison shape with ≥ 2 segmentation dimensions; arc per dimension.",
      suggestedArcs: Math.min(3, opts.brief?.segmentationDimensions?.length ?? 2),
    };
  }
  return {
    shouldDecompose: false,
    reason: "No multi-part heuristic matched.",
  };
}
