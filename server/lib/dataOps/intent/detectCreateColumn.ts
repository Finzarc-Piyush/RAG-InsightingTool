/**
 * `detectCreateColumn` — STEP 2 "create / add / make column" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Branches to `create_derived_column`
 * (conditional logic OR any arithmetic/aggregate trigger token incl. the verb
 * "add" and operator chars) vs `create_column` (static value). Runs after
 * describe and before normalize.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectCreateColumn(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage, availableColumns } = ctx;

  // Create column intent - check if it's a derived column (with expression) or simple column (with static value)
  if ((lowerMessage.includes('create') || lowerMessage.includes('add') || lowerMessage.includes('make')) &&
      (lowerMessage.includes('column') || lowerMessage.includes('new column'))) {

    // Check if it's a derived column (has expression with column references or operations)
    // Also check for conditional logic (if/then/else/otherwise/when)
    const hasConditionalLogic = /\b(if|when|where)\s+.+\s+(then|put|set|assign|use|return)/i.test(lowerMessage) ||
                                 /\botherwise|else\b/i.test(lowerMessage) ||
                                 /\bmore\s+than|less\s+than|greater\s+than|equal\s+to|not\s+equal/i.test(lowerMessage);

    if (hasConditionalLogic ||
        lowerMessage.includes('sum') || lowerMessage.includes('add') || lowerMessage.includes('+') ||
        lowerMessage.includes('multiply') || lowerMessage.includes('*') || lowerMessage.includes('times') ||
        lowerMessage.includes('subtract') || lowerMessage.includes('-') || lowerMessage.includes('minus') ||
        lowerMessage.includes('divide') || lowerMessage.includes('/') ||
        lowerMessage.includes('mean') || lowerMessage.includes('average') || lowerMessage.includes('median') ||
        lowerMessage.includes('=') && (lowerMessage.includes('[') || availableColumns.some(col => lowerMessage.includes(col)))) {
      // This is a derived column - will be handled by AI extraction
      return {
        operation: 'create_derived_column',
        requiresClarification: false
      };
    } else {
      // This is likely a simple column with static value - will be handled by AI extraction
      return {
        operation: 'create_column',
        requiresClarification: false
      };
    }
  }

  return null;
}
