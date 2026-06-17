/**
 * `detectReplaceValue` — first per-operation block of `parseDataOpsIntent`'s
 * regex fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move: the
 * "replace value" regex extraction + its result shaping, lifted VERBATIM. Runs
 * BEFORE revert/aggregate/pivot in the ordered chain.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { extractReplaceValueIntent, type IntentDetectorContext } from "./shared.js";

export function detectReplaceValue(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, availableColumns } = ctx;
  // Try to extract replace value intent (regex fallback)
  const replaceIntent = extractReplaceValueIntent(message, availableColumns);
  if (replaceIntent) {
    return {
      operation: 'replace_value',
      column: replaceIntent.column,
      oldValue: replaceIntent.oldValue,
      newValue: replaceIntent.newValue,
      requiresClarification: false
    };
  }
  return null;
}
