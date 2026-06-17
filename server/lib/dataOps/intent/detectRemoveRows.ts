/**
 * `detectRemoveRows` — STEP 2 "remove row" block of `parseDataOpsIntent`'s regex
 * fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted VERBATIM.
 * This is the LATER, looser remove-row block (distinct from the high-confidence
 * one earlier in the chain): `(remove|delete) … row` with index / last /
 * first|top. Returns null when matched-but-no-sub-pattern so the chain continues.
 * Runs after normalize and before add-row.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRemoveRows(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;

  // Remove row intent
  if ((lowerMessage.includes('remove') || lowerMessage.includes('delete')) && lowerMessage.includes('row')) {
    const indexMatch = lowerMessage.match(/row\s+(\d+)/);
    if (indexMatch) {
      return {
        operation: 'remove_rows',
        rowIndex: parseInt(indexMatch[1]!, 10),
        requiresClarification: false,
      };
    }
    if (lowerMessage.includes('last')) {
      return {
        operation: 'remove_rows',
        rowPosition: 'last',
        requiresClarification: false,
      };
    }
    if (lowerMessage.includes('first') || lowerMessage.includes('top')) {
      return {
        operation: 'remove_rows',
        rowPosition: 'first',
        requiresClarification: false,
      };
    }
  }

  return null;
}
