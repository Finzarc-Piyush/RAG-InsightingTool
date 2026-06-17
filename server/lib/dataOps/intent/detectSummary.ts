/**
 * `detectSummary` — STEP 2 summary blocks of `parseDataOpsIntent`'s regex
 * fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move: the high-priority
 * "data summary" block AND the generic "summary / statistics" block, in their
 * original order, lifted VERBATIM. Runs after the how-many block and before
 * describe. Note: a "show … summary" phrasing is already intercepted upstream by
 * the preview block (show+data) — order is load-bearing.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectSummary(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Summary intent - check for "data summary" patterns first (HIGH PRIORITY)
  if (lowerMessage.includes('data summary') || lowerMessage.includes('summary of data') ||
      lowerMessage.match(/(?:give me|show me|display|view|see)\s+(?:the\s+)?(?:data\s+)?summary/i)) {
    // Check if a specific column is mentioned
    const mentionedColumn = findMentionedColumn(message, availableColumns);

    if (mentionedColumn) {
      return {
        operation: 'summary',
        column: mentionedColumn,
        requiresClarification: false
      };
    } else {
      return {
        operation: 'summary',
        requiresClarification: false
      };
    }
  }

  // Summary intent - check if specific column is mentioned
  if (lowerMessage.includes('summary') || lowerMessage.includes('statistics')) {
    // Check if a specific column is mentioned
    const mentionedColumn = findMentionedColumn(message, availableColumns);

    if (mentionedColumn) {
      return {
        operation: 'summary',
        column: mentionedColumn,
        requiresClarification: false
      };
    } else {
      return {
        operation: 'summary',
        requiresClarification: false
      };
    }
  }

  return null;
}
