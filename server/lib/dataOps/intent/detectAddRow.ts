/**
 * `detectAddRow` — STEP 2 "add / insert / append row" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Runs after the STEP-2 remove-row
 * block and before modify-column.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectAddRow(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;
  // Add row intent
  if (lowerMessage.includes('add row') || lowerMessage.includes('insert row') || lowerMessage.includes('append row')) {
    return {
      operation: 'add_row',
      requiresClarification: false,
    };
  }
  return null;
}
