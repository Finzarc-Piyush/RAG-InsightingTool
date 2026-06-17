/**
 * `detectRevert` — STEP 0b of `parseDataOpsIntent`'s regex fallback chain
 * (ARCH-2 / CQ-2). Behaviour-preserving move: the explicit high-confidence
 * "revert / restore original" keyword block, lifted VERBATIM. Runs after
 * replace_value and before aggregate/pivot.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRevert(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;
  // Pattern: "revert to original", "restore original data", "revert table", etc.
  if (lowerMessage.includes('revert') || lowerMessage.includes('restore') ||
      (lowerMessage.includes('original') && (lowerMessage.includes('back') || lowerMessage.includes('to') || lowerMessage.includes('form')))) {
    return {
      operation: 'revert',
      requiresClarification: false,
    };
  }
  return null;
}
