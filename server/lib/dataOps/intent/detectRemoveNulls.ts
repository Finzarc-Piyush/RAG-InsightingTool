/**
 * `detectRemoveNulls` — STEP 2 deletion-focused "remove / delete / handle nulls"
 * block of `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Runs right after the fill/impute
 * block; always asks for method (or column) clarification.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRemoveNulls(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;
  // Remove nulls intent (deletion-focused)
  if (lowerMessage.includes('remove null') || lowerMessage.includes('delete null') || lowerMessage.includes('handle null')) {
    // Check if column is mentioned
    const mentionedColumn = findMentionedColumn(message, availableColumns);

    if (mentionedColumn) {
      // Column specified, need method clarification
      return {
        operation: 'remove_nulls',
        column: mentionedColumn,
        requiresClarification: true,
        clarificationType: 'method',
        clarificationMessage: `How do you want to deal with null values in "${mentionedColumn}"?\n\nOption A: Delete Row\nOption B: Impute with mean/median/mode/custom value`
      };
    } else {
      // No column specified, need column clarification
      return {
        operation: 'remove_nulls',
        requiresClarification: true,
        clarificationType: 'column',
        clarificationMessage: 'Is it about a specific column or in the entire data?'
      };
    }
  }

  return null;
}
