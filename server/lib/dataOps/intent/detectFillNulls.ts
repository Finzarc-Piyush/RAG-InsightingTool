/**
 * `detectFillNulls` — STEP 2 "fill / impute nulls" block of `parseDataOpsIntent`'s
 * regex fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted
 * VERBATIM. Checked BEFORE the deletion-focused remove-nulls block to prioritise
 * imputation. Returns a `remove_nulls` intent (operation name is shared between
 * fill and delete) with method/customValue or a clarification.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { extractCustomValue, findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectFillNulls(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;
  // Fill/Impute nulls intent (check this BEFORE remove/delete to prioritize imputation)
  if (lowerMessage.includes('fill null') || lowerMessage.includes('fill nulls') ||
      lowerMessage.includes('impute null') || lowerMessage.includes('replace null') ||
      (lowerMessage.includes('null') && (lowerMessage.includes('fill') || lowerMessage.includes('impute') || lowerMessage.includes('replace')))) {
    // Check if method is mentioned
    const mentionedColumn = findMentionedColumn(message, availableColumns);
    let method: 'mean' | 'median' | 'mode' | 'custom' | undefined;
    let customValue: any;

    if (lowerMessage.includes('mean') || lowerMessage.includes('average')) {
      method = 'mean';
    } else if (lowerMessage.includes('median')) {
      method = 'median';
    } else if (lowerMessage.includes('mode') || lowerMessage.includes('most frequent')) {
      method = 'mode';
    } else {
      // Check for custom value (number or string)
      const customValueResult = extractCustomValue(message);
      if (customValueResult.found) {
        method = 'custom';
        customValue = customValueResult.value;
      } else if (lowerMessage.includes('custom')) {
        // User mentioned "custom" but didn't specify value - need clarification
        method = 'custom';
        customValue = undefined;
      }
    }

    // If method is specified, check if custom value is needed
    if (method) {
      // If method is 'custom' but no value specified, ask for clarification
      if (method === 'custom' && customValue === undefined) {
        return {
          operation: 'remove_nulls',
          column: mentionedColumn,
          method: 'custom',
          requiresClarification: true,
          clarificationType: 'method',
          clarificationMessage: mentionedColumn
            ? `What value would you like to use to fill null values in "${mentionedColumn}"? (e.g., 0, "N/A", "Unknown", etc.)`
            : 'What value would you like to use to fill null values? (e.g., 0, "N/A", "Unknown", etc.)'
        };
      }

      // Method and value (if needed) are specified, execute directly
      return {
        operation: 'remove_nulls',
        column: mentionedColumn,
        method,
        customValue,
        requiresClarification: false
      };
    }

    // Method not specified, need clarification
    if (mentionedColumn) {
      return {
        operation: 'remove_nulls',
        column: mentionedColumn,
        requiresClarification: true,
        clarificationType: 'method',
        clarificationMessage: `How do you want to fill null values in "${mentionedColumn}"?\n\nOption A: Delete Row\nOption B: Impute with mean/median/mode/custom value`
      };
    } else {
      return {
        operation: 'remove_nulls',
        requiresClarification: true,
        clarificationType: 'method',
        clarificationMessage: 'How do you want to fill null values?\n\nOption A: Delete Row\nOption B: Impute with mean/median/mode/custom value'
      };
    }
  }

  return null;
}
