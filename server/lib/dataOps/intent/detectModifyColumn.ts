/**
 * `detectModifyColumn` — STEP 2 "increase / decrease / adjust a column" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Maps the verb to an add/subtract
 * transform and extracts the numeric value. Returns null (chain continues) when
 * the verb+value pair can't be extracted. Runs after add-row and before rename.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectModifyColumn(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Modify existing column values intent (increase/decrease a column)
  if ((lowerMessage.includes('increase') || lowerMessage.includes('decrease') || lowerMessage.includes('reduce') ||
      lowerMessage.includes('subtract') || lowerMessage.includes('add') || lowerMessage.includes('adjust')) &&
      lowerMessage.includes('column')) {
    const mentionedColumn = findMentionedColumn(message, availableColumns);
    if (mentionedColumn) {
      const verbMatch = lowerMessage.match(/\b(increase|decrease|reduce|subtract|add|adjust)\b/);
      const valueMatch = message.match(/(?:by|add|increase|decrease|reduce|subtract)\s+(-?\d+(?:\.\d+)?)/i);

      if (verbMatch && valueMatch) {
        const transformValue = parseFloat(valueMatch[1]!);
        let transformType: DataOpsIntent['transformType'];

        switch (verbMatch[1]) {
          case 'increase':
          case 'add':
          case 'adjust':
            transformType = 'add';
            break;
          case 'decrease':
          case 'reduce':
          case 'subtract':
            transformType = 'subtract';
            break;
          default:
            transformType = 'add';
        }

        return {
          operation: 'modify_column',
          column: mentionedColumn,
          transformType,
          transformValue,
          requiresClarification: false,
        };
      }
    }
  }

  return null;
}
