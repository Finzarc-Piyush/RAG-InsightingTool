/**
 * `detectPreview` — STEP 2 preview blocks of `parseDataOpsIntent`'s regex
 * fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted VERBATIM and
 * cohesive: the explicit "data preview" block, the (intentionally no-op)
 * "preview with conditions" guard, and the "show … rows" multi-pattern block.
 * FIRST sub-pattern wins, in original order. The show-block is gated on
 * `show && (data|rows|row)`, which is WHY "show me the data summary" resolves to
 * preview (the show+data block precedes the summary block) — order is
 * load-bearing.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectPreview(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;

  // Preview intent - handle "data preview", "give me data preview", "show data", etc.
  // Check for explicit "data preview" patterns first (HIGH PRIORITY)
  if (lowerMessage.includes('data preview') || lowerMessage.includes('preview data') ||
      lowerMessage.match(/(?:give me|show me|display|view|see)\s+(?:the\s+)?(?:data\s+)?preview/i)) {
    // Extract number if specified (e.g., "give me data preview of 10 rows")
    const limitMatch = lowerMessage.match(/(\d+)\s*(?:rows?|records?)?/i);
    const limit = limitMatch ? Math.min(parseInt(limitMatch[1]!, 10), 10000) : 50;

    return {
      operation: 'preview',
      previewMode: 'first',
      limit: limit,
      requiresClarification: false
    };
  }

  // Preview intent - handle first, last, specific rows, ranges, and preview with conditions
  // CRITICAL: Check for preview with conditions BEFORE checking for filter operation
  // Patterns like "give me 50 rows where X is Y" should be preview, not filter
  const previewWithConditionPattern = lowerMessage.match(/(?:give\s+me|show\s+me|show|display|get)\s+(\d+)\s+rows?\s+where/i) ||
                                      lowerMessage.match(/(?:give\s+me|show\s+me|show|display|get)\s+(\d+)\s+rows?\s+with/i);
  if (previewWithConditionPattern && !lowerMessage.includes('filter')) {
    // This is a preview request with conditions - let AI handle extracting conditions
    // But mark it as preview operation, not filter
    const limit = parseInt(previewWithConditionPattern[1]!, 10);
    if (limit > 0) {
      // Return preview operation - AI will extract filterConditions but operation stays 'preview'
      // The AI prompt will be updated to handle this case
    }
  }

  if (lowerMessage.includes('show') && (lowerMessage.includes('data') || lowerMessage.includes('rows') || lowerMessage.includes('row'))) {
    // Pattern 1: Range - handle multiple phrasings
    // "show rows 12 to 28" or "show rows 12-28" or "show rows 12 through 28"
    // "show me row from range 3 to 10 rows" or "row from range 3 to 10"
    // "range 3 to 10 rows" or "rows from range 3 to 10"
    const rangeMatch = lowerMessage.match(/rows?\s+(\d+)\s+(?:to|through|-)\s+(\d+)/i) ||
                     lowerMessage.match(/row\s+from\s+range\s+(\d+)\s+to\s+(\d+)/i) ||
                     lowerMessage.match(/range\s+(\d+)\s+to\s+(\d+)\s+rows?/i) ||
                     lowerMessage.match(/rows?\s+from\s+range\s+(\d+)\s+to\s+(\d+)/i) ||
                     lowerMessage.match(/from\s+range\s+(\d+)\s+to\s+(\d+)/i);
    if (rangeMatch) {
      const startRow = parseInt(rangeMatch[1]!, 10);
      const endRow = parseInt(rangeMatch[2]!, 10);
      if (startRow > 0 && endRow > 0 && endRow >= startRow) {
        return {
          operation: 'preview',
          previewMode: 'range',
          previewStartRow: startRow,
          previewEndRow: endRow,
          requiresClarification: false
        };
      }
    }

    // Pattern 2: Specific row - "show row 12" or "show the 12th row" or "show row number 12"
    const specificMatch = lowerMessage.match(/(?:the\s+)?(\d+)(?:st|nd|rd|th)\s+row/i) ||
                        lowerMessage.match(/row\s+(?:number\s+)?(\d+)/i) ||
                        lowerMessage.match(/show\s+(?:the\s+)?row\s+(\d+)/i);
    if (specificMatch) {
      const rowNum = parseInt(specificMatch[1]!, 10);
      if (rowNum > 0) {
        return {
          operation: 'preview',
          previewMode: 'specific',
          previewStartRow: rowNum,
          requiresClarification: false
        };
      }
    }

    // Pattern 3: Last N rows - "show last 5 rows" or "show me the last 10 rows"
    const lastMatch = lowerMessage.match(/last\s+(\d+)\s+rows?/i) ||
                    lowerMessage.match(/show\s+(?:me\s+)?(?:the\s+)?last\s+(\d+)\s+rows?/i);
    if (lastMatch) {
      const limit = parseInt(lastMatch[1]!, 10);
      if (limit > 0) {
        return {
          operation: 'preview',
          previewMode: 'last',
          limit: Math.min(limit, 10000),
          requiresClarification: false
        };
      }
    }

    // Pattern 4: First N rows - "show first 10 rows" or "show me only first 10 rows"
    const firstMatch = lowerMessage.match(/(?:first|top)\s+(\d+)\s+rows?/i) ||
                     lowerMessage.match(/show\s+(?:me\s+)?(?:only\s+)?(?:the\s+)?(?:first|top)\s+(\d+)\s+rows?/i);
    if (firstMatch) {
      const limit = parseInt(firstMatch[1]!, 10);
      if (limit > 0) {
        return {
          operation: 'preview',
          previewMode: 'first',
          limit: Math.min(limit, 10000),
          requiresClarification: false
        };
      }
    }

    // Pattern 5: Generic "show N rows" - defaults to first N
    const genericMatch = lowerMessage.match(/show\s+(?:me\s+)?(?:only\s+)?(?:the\s+)?(\d+)\s+rows?/i);
    if (genericMatch) {
      const limit = parseInt(genericMatch[1]!, 10);
      if (limit > 0) {
        return {
          operation: 'preview',
          previewMode: 'first',
          limit: Math.min(limit, 10000),
          requiresClarification: false
        };
      }
    }

    // Pattern 6: Simple "show N" or "first N" - defaults to first N
    const simpleMatch = lowerMessage.match(/(?:show|first|top)\s+(\d+)/i);
    if (simpleMatch) {
      const limit = parseInt(simpleMatch[1]!, 10);
      if (limit > 0) {
        return {
          operation: 'preview',
          previewMode: 'first',
          limit: Math.min(limit, 10000),
          requiresClarification: false
        };
      }
    }

    // Default: show first 50 rows
    return {
      operation: 'preview',
      previewMode: 'first',
      limit: 50,
      requiresClarification: false
    };
  }

  return null;
}
