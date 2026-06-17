/**
 * `detectRemoveColumnHighConfidence` — the high-confidence "remove column"
 * block of `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Runs BEFORE the clarification /
 * STEP-2 logic so an explicit "remove the column X" is never mistaken for a
 * clarification response to a prior nulls question. Allows typos via "remov*".
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRemoveColumnHighConfidence(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, availableColumns } = ctx;
  // High-confidence "remove column" pattern (regex fallback) – this should not be treated as
  // a clarification response even if we were previously asking about nulls.
  // Allow common typos like "remover"/"removing" by matching "remov*"
  const removeColumnRegex = /\b(remove|remov\w*|delete|drop)\s+(the\s+)?(column|col)\b/i;
  if (removeColumnRegex.test(message)) {
    const mentionedColumn = findMentionedColumn(message, availableColumns);

    if (mentionedColumn) {
    return {
        operation: 'remove_column',
        column: mentionedColumn,
        requiresClarification: false,
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
