/**
 * `detectNormalizeColumn` — STEP 2 "normalize / standardize column" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM, including the bespoke multi-word
 * column matching (exact → all-words → findMentionedColumn fallback). Runs after
 * create-column and before the STEP-2 remove-row block.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectNormalizeColumn(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Normalize column intent
  if (lowerMessage.includes('normalize') || lowerMessage.includes('normalise') || lowerMessage.includes('standardize')) {
    // First, try to extract column name using regex pattern
    // Patterns: "normalize Emami 7 Oils TOM", "normalize the column X", "normalize column X"
    let extractedColumnName: string | undefined;

    // Pattern 1: "normalize [column name]" - captures everything after "normalize" to end of message
    // Then we'll clean it up by removing stop words
    const normalizePattern1 = /\b(normalize|normalise|standardize)\s+(?:the\s+)?(?:column\s+)?(.+)/i;
    const match1 = message.match(normalizePattern1);
    if (match1 && match1[2]) {
      extractedColumnName = match1[2].trim();
      // Remove common stop words that might be at the end (but preserve column name words)
      extractedColumnName = extractedColumnName.replace(/\s+(please|can|you|will|the|column|columns|for|to|with|by)$/i, '').trim();
      // Remove trailing punctuation
      extractedColumnName = extractedColumnName.replace(/[.,;:!?]+$/, '');
    }

    // If we extracted a column name, try to match it against available columns
    let mentionedColumn: string | undefined;
    if (extractedColumnName) {
      const normalizedExtracted = extractedColumnName.toLowerCase().replace(/\s+/g, ' ').trim();
      const extractedWords = normalizedExtracted.split(/\s+/).filter(w => w.length > 0);

      // First try exact match (case-insensitive, normalized spaces)
      for (const col of availableColumns) {
        const normalizedCol = col.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalizedCol === normalizedExtracted) {
          mentionedColumn = col;
          break;
        }
      }

      // If no exact match, try to find column where ALL words from extracted name match
      // This ensures "Emami 7 Oils TOM" matches "Emami 7 Oils TOM" not "Emami 7 Oils nGRP"
      if (!mentionedColumn && extractedWords.length > 0) {
        // Sort columns by length (longest first) to prioritize more specific matches
        const sortedColumns = [...availableColumns].sort((a, b) => b.length - a.length);

        for (const col of sortedColumns) {
          const colLower = col.toLowerCase();
          let allWordsMatch = true;
          let matchCount = 0;

          for (const word of extractedWords) {
            // Use word boundary regex to ensure we match complete words
            const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (wordRegex.test(colLower)) {
              matchCount++;
            } else {
              // If word doesn't match as a word boundary, check if it's a substring
              // but only if the word is significant (length >= 2)
              if (word.length >= 2 && colLower.includes(word)) {
                matchCount++;
              } else {
                allWordsMatch = false;
                break;
              }
            }
          }

          // If all words match, return this column immediately
          if (allWordsMatch && matchCount === extractedWords.length) {
            mentionedColumn = col;
            break;
          }
        }
      }

      // If still no match, try word-boundary matching with the extracted name
      if (!mentionedColumn) {
        mentionedColumn = findMentionedColumn(extractedColumnName, availableColumns);
      }
    }

    // Fallback to original method if regex extraction didn't work
    if (!mentionedColumn) {
      mentionedColumn = findMentionedColumn(message, availableColumns);
    }

    if (mentionedColumn) {
      return {
        operation: 'normalize_column',
        column: mentionedColumn,
        requiresClarification: false,
      };
    } else {
      return {
        operation: 'normalize_column',
        requiresClarification: true,
        clarificationType: 'column',
        clarificationMessage: 'Which column would you like to normalize?'
      };
    }
  }

  return null;
}
