/**
 * `detectDescribe` — STEP 2 conversational "describe data" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Runs after the summary block and
 * before the create-column block.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectDescribe(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;
  // Describe data intent (conversational)
  if (lowerMessage.includes('describe') || lowerMessage.includes('tell me about') ||
      lowerMessage.includes('what is') || lowerMessage.includes('how many rows') ||
      lowerMessage.includes('how many columns') || lowerMessage.includes('data shape') ||
      lowerMessage.includes('data size')) {
    return {
      operation: 'describe',
      requiresClarification: false
    };
  }
  return null;
}
