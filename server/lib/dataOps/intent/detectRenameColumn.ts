/**
 * `detectRenameColumn` — STEP 2 "rename column" block of `parseDataOpsIntent`'s
 * regex fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted
 * VERBATIM. Checked BEFORE the STEP-2 remove_column block to avoid conflicts.
 * Three sub-patterns (X→Y, X Y, context-ref) then a clarification fallthrough.
 * Once the outer rename intent fires, this detector ALWAYS returns a result
 * (never null), so later detectors don't see a rename message.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMatchingColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectRenameColumn(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Rename column intent - check BEFORE remove_column to avoid conflicts
  if ((lowerMessage.includes('rename') || lowerMessage.includes('change') || lowerMessage.includes('update')) &&
      (lowerMessage.includes('column') || lowerMessage.includes('name'))) {
    // Pattern 1: "rename column X to Y" or "change column name from X to Y"
    const renamePattern1 = /(?:rename|change|update)\s+(?:the\s+)?(?:column\s+)?(?:name\s+)?(?:from\s+)?["']?([^"'\s]+)["']?\s+to\s+["']?([^"'\s]+)["']?/i;
    const match1 = message.match(renamePattern1);
    if (match1) {
      const oldName = match1[1]!.trim();
      const newName = match1[2]!.trim();
      const matchedColumn = findMatchingColumn(oldName, availableColumns);
      return {
        operation: 'rename_column',
        oldColumnName: matchedColumn || oldName,
        column: matchedColumn || oldName,
        newColumnName: newName,
        requiresClarification: false
      };
    }

    // Pattern 2: "rename column X Y" (without "to")
    const renamePattern2 = /(?:rename|change|update)\s+(?:the\s+)?column\s+["']?([^"'\s]+)["']?\s+["']?([^"'\s]+)["']?/i;
    const match2 = message.match(renamePattern2);
    if (match2 && !lowerMessage.includes('to')) {
      const oldName = match2[1]!.trim();
      const newName = match2[2]!.trim();
      const matchedColumn = findMatchingColumn(oldName, availableColumns);
      return {
        operation: 'rename_column',
        oldColumnName: matchedColumn || oldName,
        column: matchedColumn || oldName,
        newColumnName: newName,
        requiresClarification: false
      };
    }

    // Pattern 3: "change the above column name to X" or "rename that column to X"
    // This will be handled by context resolution, but we can still detect the operation
    if ((lowerMessage.includes('above') || lowerMessage.includes('that') || lowerMessage.includes('it') ||
         lowerMessage.includes('previous') || lowerMessage.includes('last')) &&
        lowerMessage.includes('to')) {
      const toMatch = message.match(/\bto\s+["']?([^"'\s]+)["']?/i);
      if (toMatch) {
        const newName = toMatch[1]!.trim();
        // Column will be resolved from context
        return {
          operation: 'rename_column',
          newColumnName: newName,
          requiresClarification: false
        };
      }
    }

    // If we detected rename intent but couldn't extract names, ask for clarification
    return {
      operation: 'rename_column',
      requiresClarification: true,
      clarificationType: 'column',
      clarificationMessage: 'Which column would you like to rename, and what should the new name be? For example: "Rename column Sales to Revenue"'
    };
  }

  return null;
}
