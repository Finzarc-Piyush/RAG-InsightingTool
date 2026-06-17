/**
 * `detectRemoveColumn` — STEP 2 "remove column" block of `parseDataOpsIntent`'s
 * regex fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted
 * VERBATIM. This is the LATER, keyword-based remove-column block (distinct from
 * the high-confidence regex one earlier in the chain): `(remove|delete|drop)` +
 * `(column|col)`. Runs after rename and before convert-type.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRemoveColumn(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Remove column intent
  if ((lowerMessage.includes('remove') || lowerMessage.includes('delete') || lowerMessage.includes('drop')) &&
      (lowerMessage.includes('column') || lowerMessage.includes('col'))) {
    const mentionedColumn = findMentionedColumn(message, availableColumns);

    if (mentionedColumn) {
      return {
        operation: 'remove_column',
        column: mentionedColumn,
        requiresClarification: false
      };
    } else {
      return {
        operation: 'remove_column',
        requiresClarification: true,
        clarificationType: 'column',
        clarificationMessage: 'Which column would you like to remove? Please specify the column name.'
      };
    }
  }

  return null;
}
