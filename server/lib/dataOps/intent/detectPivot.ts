/**
 * `detectPivot` — STEP 0c pivot blocks of `parseDataOpsIntent`'s regex fallback
 * chain (ARCH-2 / CQ-2). Behaviour-preserving move: the THREE pivot patterns in
 * their original order, lifted VERBATIM:
 *   1. "create a pivot on X showing A, B, C fields"
 *   2. simple "pivot (table) for/on/by X [showing …| over rest …]"
 *   3. explicit "pivot (table) for/on/by X over rest of the columns"
 * FIRST-match-wins. Runs immediately after the aggregate patterns.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectPivot(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, availableColumns } = ctx;

  // Pattern: "create a pivot on X showing A, B, C fields"
  const pivotRegex =
    /\bcreate\s+(?:a\s+)?pivot\s+on\s+([a-zA-Z0-9_ ]+?)\s+showing\s+([a-zA-Z0-9_,&\s]+?)\s*(?:fields?|columns?)?(?:\?|$)/i;
  const pivotMatch = pivotRegex.exec(message);
  if (pivotMatch) {
    const rawIndex = pivotMatch[1]!.trim();
    const rawValues = pivotMatch[2]!.trim();

    const pivotIndex =
      findMentionedColumn(rawIndex, availableColumns) || rawIndex;

    const pivotValues = rawValues
      .split(/[,&]/)
      .map(v => v.trim())
      .filter(v => v.length > 0)
      .map(v => findMentionedColumn(v, availableColumns) || v);

    return {
      operation: 'pivot',
      pivotIndex,
      pivotValues,
      requiresClarification: false,
    };
  }

  // Pattern: "pivot table for X" or "pivot for X" or "pivot on X" or "pivot by X"
  // Also handles "pivot table for X over rest of the columns" or "over remaining columns"
  // This handles simpler requests where user just specifies the index column
  const simplePivotRegex = /\b(?:create\s+)?(?:a\s+)?pivot\s+(?:table\s+)?(?:for|on|by)\s+([a-zA-Z0-9_ ]+?)(?:\s+(?:showing\s+([a-zA-Z0-9_,&\s]+?)|over\s+(?:rest|remaining|all)\s+(?:of\s+)?(?:the\s+)?(?:columns?|fields?)))?\s*(?:fields?|columns?)?(?:\?|$)/i;
  const simplePivotMatch = simplePivotRegex.exec(message);
  if (simplePivotMatch) {
    const rawIndex = simplePivotMatch[1]!.trim();
    const rawValues = simplePivotMatch[2] ? simplePivotMatch[2].trim() : '';

    const pivotIndex =
      findMentionedColumn(rawIndex, availableColumns) || rawIndex;

    let pivotValues: string[] = [];
    if (rawValues) {
      pivotValues = rawValues
        .split(/[,&]/)
        .map(v => v.trim())
        .filter(v => v.length > 0)
        .map(v => findMentionedColumn(v, availableColumns) || v);
    }
    // If no value columns specified (or "over rest of columns" mentioned), will be handled in executeDataOperation to use all columns

    return {
      operation: 'pivot',
      pivotIndex,
      pivotValues,
      requiresClarification: false,
    };
  }

  // Additional pattern: "pivot table for X over rest of the columns" (more explicit)
  const pivotOverRestRegex = /\b(?:create\s+)?(?:a\s+)?pivot\s+(?:table\s+)?(?:for|on|by)\s+([a-zA-Z0-9_ ]+?)\s+over\s+(?:rest|remaining|all)\s+(?:of\s+)?(?:the\s+)?(?:columns?|fields?)/i;
  const pivotOverRestMatch = pivotOverRestRegex.exec(message);
  if (pivotOverRestMatch) {
    const rawIndex = pivotOverRestMatch[1]!.trim();
    const pivotIndex =
      findMentionedColumn(rawIndex, availableColumns) || rawIndex;

    return {
      operation: 'pivot',
      pivotIndex,
      pivotValues: [], // Empty means use all other columns
      requiresClarification: false,
    };
  }

  return null;
}
