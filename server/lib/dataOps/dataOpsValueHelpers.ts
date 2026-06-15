/**
 * Data Ops value / column-matching helpers
 *
 * Extracted from dataOpsOrchestrator.ts (Wave R31 · safe re-export extraction).
 * These are pure, self-contained helpers for the natural-language data-ops
 * intent parser: extracting custom fill values, fuzzy-matching a mentioned
 * column against the available schema, and coercing arbitrary cell values to
 * numbers. They depend ONLY on the standard library — no project imports, no
 * coupling to the orchestrator's dispatch state — so they live cleanly in a
 * sibling module and are re-exported from dataOpsOrchestrator.ts for any
 * existing internal callers.
 */

/**
 * Extract custom value from message (handles numbers and strings)
 * Examples: "fill nulls with 0", "fill nulls with the 132.45", "fill nulls with 'N/A'", "fill nulls with N/A", "fill nulls with Unknown"
 */
export function extractCustomValue(message: string): { value: any; found: boolean } {
  const lowerMessage = message.toLowerCase();

  // Patterns to match custom value specifications
  // "with 0", "with the 132.45", "with 'N/A'", "with N/A", "with Unknown", "as 0", "as 'N/A'", etc.

  // Try number pattern first - handle "with 0", "with the 132.45", "with value 123.45", etc.
  // Pattern: (with|as|value|using|to) (optional: the|a|an) (number)
  // Match both "with 132.45" and "with the 132.45"
  // Use word boundaries to ensure we match the right "with"
  const numberPatterns = [
    /\b(?:with|as|value|using|to)\s+(?:the|a|an)\s+(-?\d+\.?\d*)/i,  // "with the 132.45"
    /\b(?:with|as|value|using|to)\s+(-?\d+\.?\d*)/i,  // "with 132.45"
  ];

  for (const pattern of numberPatterns) {
    const numberMatch = message.match(pattern);
    if (numberMatch && numberMatch[1]) {
      const numStr = numberMatch[1].trim();
      const num = parseFloat(numStr);
      if (!isNaN(num) && isFinite(num)) {
        return { value: num, found: true };
      }
    }
  }

  // Try quoted string pattern - "with 'N/A'", "with \"Unknown\"", "with the 'value'"
  const quotedMatch = message.match(/(?:with|as|value|using|to)\s+(?:the|a|an)?\s*['"]([^'"]+)['"]/i);
  if (quotedMatch) {
    return { value: quotedMatch[1], found: true };
  }

  // Try unquoted string pattern (but exclude common method words and articles)
  // This should come last to avoid matching "the" or "a" as values
  // Match patterns like "with N/A", "with Unknown", but NOT "with the" or "with a"
  const unquotedPatterns = [
    /(?:with|as|value|using|to)\s+(?:the|a|an)\s+([A-Za-z][A-Za-z0-9\s_-]+?)(?:\s|$|,|\.|;|in|for|from)/i,  // "with the N/A"
    /(?:with|as|value|using|to)\s+([A-Za-z][A-Za-z0-9\s_-]+?)(?:\s|$|,|\.|;|in|for|from)/i,  // "with N/A"
  ];

  for (const pattern of unquotedPatterns) {
    const unquotedMatch = message.match(pattern);
    if (unquotedMatch) {
      const potentialValue = unquotedMatch[1]!.trim();
      // Exclude method keywords and articles
      const methodKeywords = ['mean', 'median', 'mode', 'custom', 'delete', 'remove', 'fill', 'impute', 'replace', 'the', 'a', 'an', 'null', 'value', 'values'];
      if (potentialValue && !methodKeywords.includes(potentialValue.toLowerCase())) {
        return { value: potentialValue, found: true };
      }
    }
  }

  return { value: undefined, found: false };
}

/**
 * Find mentioned column in message
 * Improved to handle cases like "Emami 7 Oils TOM" matching "Emami 7 Oils TOM" instead of "Emami 7 Oils nGRP"
 */
export function findMentionedColumn(message: string, availableColumns: string[]): string | undefined {
  const lowerMessage = message.toLowerCase();

  // Extract potential column name from message by removing common operation words
  // This helps isolate the column name better
  const operationWords = ['normalize', 'normalise', 'standardize', 'remove', 'delete', 'drop',
                          'create', 'add', 'make', 'modify', 'change', 'update', 'convert',
                          'replace', 'fill', 'count', 'show', 'display', 'get', 'find'];
  let cleanedMessage = lowerMessage;
  for (const opWord of operationWords) {
    cleanedMessage = cleanedMessage.replace(new RegExp(`\\b${opWord}\\b`, 'gi'), '').trim();
  }
  // Remove common words that might interfere, but preserve important words like "TOM", "nGRP", etc.
  cleanedMessage = cleanedMessage.replace(/\b(the|a|an|column|columns|value|values|with|to|by|for|in|on|at)\b/gi, '').trim();

  // If cleaned message is too short or empty, use original message
  if (cleanedMessage.length < 3) {
    cleanedMessage = lowerMessage;
  }

  // Try exact match first (case-insensitive, ignoring extra spaces)
  for (const col of availableColumns) {
    const colLower = col.toLowerCase().trim();
    const colNormalized = colLower.replace(/\s+/g, ' ');
    const msgNormalized = cleanedMessage.replace(/\s+/g, ' ');

    // Exact match (normalized)
    if (colNormalized === msgNormalized) {
      return col;
    }

    // Exact match with original message (if column name appears as-is)
    if (lowerMessage.includes(colLower) && colLower.length >= 3) {
      // Check if it's a word-boundary match (not just substring)
      const wordBoundaryRegex = new RegExp(`\\b${colLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordBoundaryRegex.test(message)) {
        return col;
      }
    }
  }

  // Try word-boundary matching - all words from search term must appear in column
  const searchWords = cleanedMessage.split(/\s+/).filter(w => w.length >= 1); // Allow single char words like "7"
  if (searchWords.length > 0) {
    // Sort columns by length (longest first) to prioritize more specific matches
  const sortedColumns = [...availableColumns].sort((a, b) => b.length - a.length);

    // First, try to find columns where ALL words match (perfect match)
  for (const col of sortedColumns) {
      const colLower = col.toLowerCase();
      let allWordsMatch = true;
      let matchCount = 0;

      for (const word of searchWords) {
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
      if (allWordsMatch && matchCount === searchWords.length) {
        return col;
      }
    }

    // If no perfect match, try to find column with highest word match count
    // Prioritize columns that match the LAST word (often the distinguishing part like "TOM" vs "nGRP")
    const lastWord = searchWords[searchWords.length - 1];
    let bestMatch: { col: string; score: number } | null = null;

    for (const col of sortedColumns) {
      const colLower = col.toLowerCase();
      let matchCount = 0;
      let lastWordMatches = false;

      for (let i = 0; i < searchWords.length; i++) {
        const word = searchWords[i]!;
        const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        const matches = wordRegex.test(colLower) || (word.length >= 2 && colLower.includes(word));

        if (matches) {
          matchCount++;
          // Check if this is the last word
          if (i === searchWords.length - 1) {
            lastWordMatches = true;
          }
        }
      }

      // Calculate score:
      // - Base score: percentage of words matched
      // - Bonus: if last word matches (critical for distinguishing "TOM" vs "nGRP")
      // - Bonus: longer column names (more specific)
      let score = (matchCount / searchWords.length) * 100;
      if (lastWordMatches) {
        score += 50; // Big bonus for matching the last word
      }
      score += (col.length / 100); // Small bonus for longer names

      if (matchCount > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { col, score };
      }
    }

    // Require at least 50% word match, or if last word matches, require at least 30%
    const minScore = lastWord && bestMatch?.col.toLowerCase().includes(lastWord.toLowerCase()) ? 30 : 50;
    if (bestMatch && bestMatch.score >= minScore) {
      return bestMatch.col;
    }
  }

  // Fallback: Try substring match, but only for longer substrings (>= 5 chars)
  // This prevents matching "Emami 7 Oils" when user says "Emami 7 Oils TOM"
  const sortedColumns = [...availableColumns].sort((a, b) => b.length - a.length);
  for (const col of sortedColumns) {
    const colLower = col.toLowerCase();
    // Only match if the substring is significant (>= 5 chars) or if it's an exact word match
    if (lowerMessage.includes(colLower) && (colLower.length >= 5 ||
        new RegExp(`\\b${colLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message))) {
      return col;
    }
  }

  // Try column number (e.g., "column 3", "column#3")
  const colNumMatch = message.match(/column\s*#?\s*(\d+)/i);
  if (colNumMatch) {
    const colIndex = parseInt(colNumMatch[1]!, 10) - 1;
    if (colIndex >= 0 && colIndex < availableColumns.length) {
      return availableColumns[colIndex];
    }
  }

  return undefined;
}

/**
 * Find matching column (fuzzy match)
 */
export function findMatchingColumn(searchName: string, availableColumns: string[]): string | undefined {
  const normalized = searchName.toLowerCase().replace(/[\s_-]/g, '');

  // Prefer exact matches first
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (colNormalized === normalized) {
      return col;
    }
  }

  // Fallback to columns that contain the search term
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (colNormalized.includes(normalized)) {
      return col;
    }
  }

  return undefined;
}

export function normalizeNumericValue(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = parseFloat(String(value).replace(/[,%\$]/g, '').trim());
  return Number.isNaN(parsed) ? null : parsed;
}
