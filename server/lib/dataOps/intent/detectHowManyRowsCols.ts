/**
 * `detectHowManyRowsCols` — STEP 2 "how many rows / columns" blocks of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move: the two consecutive keyword blocks (rows, then
 * columns), lifted VERBATIM. Both resolve to `describe`. Runs after count_nulls
 * and before the summary block.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectHowManyRowsCols(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;

  // Handle "how many rows/columns" questions
  if (lowerMessage.includes('how many rows') || lowerMessage.includes('how many records')) {
    return {
      operation: 'describe',
      requiresClarification: false
    };
  }

  if (lowerMessage.includes('how many columns') || lowerMessage.includes('how many variables')) {
    return {
      operation: 'describe',
      requiresClarification: false
    };
  }

  return null;
}
