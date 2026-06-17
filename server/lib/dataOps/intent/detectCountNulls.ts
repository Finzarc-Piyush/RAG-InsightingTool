/**
 * `detectCountNulls` — STEP 2 conversational "count nulls" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Runs right after the preview block.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectCountNulls(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;
  // Count nulls intent (conversational) - handle various phrasings
  if ((lowerMessage.includes('null') || lowerMessage.includes('missing') || lowerMessage.includes('empty')) &&
      (lowerMessage.includes('how many') || lowerMessage.includes('count') ||
       lowerMessage.includes('number of') || lowerMessage.includes('how much') ||
       lowerMessage.includes('are there'))) {
    const mentionedColumn = findMentionedColumn(message, availableColumns);
    return {
      operation: 'count_nulls',
      column: mentionedColumn,
      requiresClarification: false
    };
  }
  return null;
}
