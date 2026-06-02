/**
 * ============================================================================
 * investigationDispatch.ts — route a turn to deep investigation or not
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Decides whether a chat turn should run the heavier multi-thread "deep
 *   investigation" orchestrator (which explores several sub-questions in
 *   parallel) or the normal single-flow agentic loop (runAgentTurn). The
 *   decision is deterministic and cheap — pure regex, no AI.
 *
 * WHY IT MATTERS
 *   Deep investigation is gated behind a feature flag by design (invariant #6:
 *   re-wiring deep investigation requires a flag). This dispatcher only reads
 *   that flag and applies a multi-part trigger; it never changes the default.
 *
 * KEY PIECES
 *   - DeepInvestigationDispatchDecision — { fire, reason, optional multiPart }.
 *   - shouldDispatchDeepInvestigation(question) — fire only when the flag is on
 *     AND the question splits into >= 2 sub-questions.
 *
 * HOW IT CONNECTS
 *   Reads the flag from investigationTree.ts (isDeepInvestigationEnabled) and
 *   splits questions via detectMultiPartQuestion.ts. The returned decision lets
 *   the caller emit a `flow_decision` SSE row for the workbench timeline and,
 *   when fire is true, invoke the investigationOrchestrator. Pure function, no I/O.
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
