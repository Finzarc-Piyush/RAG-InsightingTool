/**
 * Wave W73 · Deep-investigation dispatch.
 *
 * Determines whether a chat turn should run the multi-thread deep
 * investigation orchestrator
 * ([investigationOrchestrator.ts](./investigationOrchestrator.ts)) or the
 * standard single-flow agentic loop (`runAgentTurn`).
 *
 * Decision is deterministic + cheap (pure regex):
 *
 *   - Master gate: `DEEP_INVESTIGATION_ENABLED` env var
 *     ([investigationTree.ts](./investigationTree.ts) :: `isDeepInvestigationEnabled`).
 *     Invariant #6 — re-wiring deep investigation requires a feature flag.
 *     This dispatcher *uses* the flag, doesn't change its default.
 *
 *   - Trigger: question is multi-part per `detectMultiPartQuestion` (W11
 *     D1). Future wave (W74+) widens the trigger to investigative
 *     `questionShape` (`driver_discovery`, `variance_diagnostic`,
 *     `comparison`) once `analysisBrief` is computed pre-turn.
 *
 * Returns a structured decision so callers can emit a `flow_decision`
 * SSE row for the workbench timeline.
 *
 * Pure function. No I/O.
 */

import {
  detectMultiPartQuestion,
  type MultiPartIntent,
} from "./detectMultiPartQuestion.js";
import { isDeepInvestigationEnabled } from "./investigationTree.js";

export interface DeepInvestigationDispatchDecision {
  /** Whether to invoke `runDeepInvestigation`. */
  fire: boolean;
  /** Human-readable rationale (for `flow_decision` SSE + telemetry). */
  reason: string;
  /** Detected multi-part intent when `fire === true`. */
  multiPart?: MultiPartIntent;
}

/**
 * Decide whether to dispatch the deep investigator for this question.
 *
 * Returns `{ fire: false }` when:
 *   - `DEEP_INVESTIGATION_ENABLED` env var is not set / not "true" / not "1"
 *   - Question is empty / undefined
 *   - Question is single-part per `detectMultiPartQuestion`
 *
 * Returns `{ fire: true, multiPart }` when the master gate is on AND the
 * question splits into ≥ 2 sub-questions.
 */
export function shouldDispatchDeepInvestigation(
  question: string | undefined,
): DeepInvestigationDispatchDecision {
  if (!isDeepInvestigationEnabled()) {
    return {
      fire: false,
      reason: "DEEP_INVESTIGATION_ENABLED is not set",
    };
  }
  const q = (question ?? "").trim();
  if (!q) {
    return { fire: false, reason: "empty question" };
  }
  const intent = detectMultiPartQuestion(q);
  if (!intent) {
    return {
      fire: false,
      reason: "single-part question — no multi-part trigger",
    };
  }
  return {
    fire: true,
    reason: `multi-part question · ${intent.subQuestions.length} sub-questions · trigger="${intent.trigger}"`,
    multiPart: intent,
  };
}
