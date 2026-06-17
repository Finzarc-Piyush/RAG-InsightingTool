/**
 * `detectConvertType` — STEP 2 "convert column type" block of
 * `parseDataOpsIntent`'s regex fallback chain (ARCH-2 / CQ-2).
 * Behaviour-preserving move, lifted VERBATIM, including the two convert patterns
 * and the bespoke multi-word column matching + clarification branches. Runs after
 * remove_column and before the model-advice / train-model blocks.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectConvertType(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, availableColumns } = ctx;

  // Type conversion intent - handle multi-word column names
  // Patterns: "convert Dove nGRP Adstocked to string", "convert column X to numeric", etc.
  const convertTypePatterns = [
    // Pattern 1: "convert [column name] to [type]" - captures everything between "convert" and "to"
    /\b(convert|change|transform)\s+(?:the\s+)?(?:column\s+)?(.+?)\s+(?:data\s+)?type\s+to\s+(numeric|string|date|percentage|boolean|number)/i,
    // Pattern 2: "convert [column name] to [type]" - simpler pattern
    /\b(convert|change|transform)\s+(?:the\s+)?(?:column\s+)?(.+?)\s+to\s+(numeric|string|date|percentage|boolean|number)/i,
  ];

  for (const pattern of convertTypePatterns) {
    const typeMatch = message.match(pattern);
    if (typeMatch) {
      let extractedColumnName = typeMatch[2]!.trim();
      const targetTypeRaw = (typeMatch[3] || typeMatch[4] || '').toLowerCase();

      // Clean up extracted column name - remove common stop words at the end
      extractedColumnName = extractedColumnName.replace(/\s+(please|can|you|will|the|column|columns|for|to|with|by|data|type)$/i, '').trim();
      // Remove trailing punctuation
      extractedColumnName = extractedColumnName.replace(/[.,;:!?]+$/, '');

      // Try to match the extracted column name against available columns
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

        // If still no match, try the original findMentionedColumn function
        if (!mentionedColumn) {
          mentionedColumn = findMentionedColumn(extractedColumnName, availableColumns);
        }
      }

      if (mentionedColumn && targetTypeRaw) {
        const normalizedTarget = (targetTypeRaw === 'number' ? 'numeric' : targetTypeRaw) as 'numeric' | 'string' | 'date' | 'percentage' | 'boolean';
        return {
          operation: 'convert_type',
          column: mentionedColumn,
          targetType: normalizedTarget,
          requiresClarification: false
        };
      } else if (!mentionedColumn) {
        return {
          operation: 'convert_type',
          requiresClarification: true,
          clarificationType: 'column',
          clarificationMessage: `Column "${extractedColumnName}" not found. Please specify a valid column name.`
        };
      } else if (!targetTypeRaw) {
        return {
          operation: 'convert_type',
          column: mentionedColumn,
          requiresClarification: true,
          clarificationType: 'target_type',
          clarificationMessage: `What type would you like to convert "${mentionedColumn}" to? (numeric, string, date, percentage, or boolean)`
        };
      }
    }
  }

  return null;
}
