/**
 * `detectRemoveRowsHighConfidence` — the high-confidence "remove row(s)" block
 * of `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM. Handles explicit
 * keep-first / first-N / last-N / first|last / row-index BEFORE any
 * clarification / AI logic. FIRST sub-pattern wins, in original order. Runs
 * right after the high-confidence remove_column block.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRemoveRowsHighConfidence(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message } = ctx;

  // Pattern: "keep only first N rows" or "keep first N rows" - convert to "remove last (total - N) rows"
  // Also handles: "keep only the first N rows from the dataset and remove the rest"
  const keepFirstRegex = /\bkeep\s+(?:only\s+)?(?:the\s+)?first\s+(\d+)\s+rows?/i;
  const keepFirstMatch = keepFirstRegex.exec(message);
  if (keepFirstMatch) {
    const count = parseInt(keepFirstMatch[1]!, 10);
    if (!Number.isNaN(count) && count > 0) {
      // "Keep only first N rows" means "remove last (total - N) rows"
      // We'll handle this in executeDataOperation by calculating total - N
      return {
        operation: 'remove_rows',
        rowPosition: 'keep_first', // Special flag to indicate "keep first N, remove rest"
        rowCount: count,
        requiresClarification: false,
      };
    }
  }

  // Pattern: remove/delete/drop the first/last row
  const firstLastRowRegex = /\b(remove|remov\w*|delete|drop)\s+(the\s+)?(first|last)\s+row\b/i;
  const rowIndexRegex = /\b(remove|remov\w*|delete|drop)\s+row\s+(\d+)\b/i;
  const firstNRowsRegex = /\b(remove|remov\w*|delete|drop)\s+(the\s+)?first\s+(\d+)\s+rows?\b/i;
  const lastNRowsRegex = /\b(remove|remov\w*|delete|drop)\s+(the\s+)?last\s+(\d+)\s+rows?\b/i;

  // Explicit "first N rows"
  const firstNMatch = firstNRowsRegex.exec(message);
  if (firstNMatch) {
    const count = parseInt(firstNMatch[3]!, 10);
    if (!Number.isNaN(count) && count > 0) {
    return {
        operation: 'remove_rows',
        rowPosition: 'first',
        rowCount: count,
        requiresClarification: false,
      };
    }
  }

  // Explicit "last N rows"
  const lastNMatch = lastNRowsRegex.exec(message);
  if (lastNMatch) {
    const count = parseInt(lastNMatch[3]!, 10);
    if (!Number.isNaN(count) && count > 0) {
    return {
        operation: 'remove_rows',
        rowPosition: 'last',
        rowCount: count,
        requiresClarification: false,
      };
    }
  }

  const firstLastMatch = firstLastRowRegex.exec(message);
  if (firstLastMatch) {
    const which = firstLastMatch[3]!.toLowerCase();
    return {
      operation: 'remove_rows',
      rowPosition: which === 'last' ? 'last' : 'first',
      requiresClarification: false,
    };
  }

  const rowIndexMatch = rowIndexRegex.exec(message);
  if (rowIndexMatch) {
    const index = parseInt(rowIndexMatch[2]!, 10);
    if (!Number.isNaN(index) && index > 0) {
      return {
        operation: 'remove_rows',
        rowIndex: index,
        requiresClarification: false,
      };
    }
  }

  return null;
}
