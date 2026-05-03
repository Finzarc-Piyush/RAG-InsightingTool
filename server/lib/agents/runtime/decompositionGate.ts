/**
 * Wave B7 · feature flag gate + question-shape predicate for decomposition.
 *
 * The coordinator's `decomposeQuestion` and the investigation orchestrator
 * (`runInvestigationOrchestrator`) both exist as live code but are unwired
 * from `runAgentTurn` per the W11-W13 single-flow policy. This module
 * provides a single read-only check the agent loop can call: "should this
 * turn run as multiple parallel arcs?".
 *
 * Default off. Enable per-deploy via `AGENT_DECOMPOSITION_ENABLED=true`.
 *
 * Question shapes that benefit from decomposition:
 *   - `multi_part`: explicit conjunction ("X AND what should we do?").
 *   - `why_drop_with_action`: causal + recommendation in one breath.
 *   - `compare_segments`: A vs B that wants explicit per-arc evidence.
 */
import type { AnalysisBrief } from "../../../shared/schema.js";

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
  const enabled =
    (process.env.AGENT_DECOMPOSITION_ENABLED ?? "false").toLowerCase() === "true";
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
