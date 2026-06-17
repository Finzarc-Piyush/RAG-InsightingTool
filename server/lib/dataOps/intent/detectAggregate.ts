/**
 * `detectAggregate` — STEP 0c aggregate blocks of `parseDataOpsIntent`'s regex
 * fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move: the SEVEN
 * high-confidence aggregate patterns, in their original order, lifted VERBATIM:
 *   1. "aggregate X, group by Y, order by Z DESC"
 *   2. "aggregate X on Y"
 *   3. simpler catch-all "aggregate … on …"
 *   4. "aggregate all (other) columns by X [using fn]"
 *   5. "aggregate over X"
 *   6. "aggregate X by Y using fn"
 *   7. "aggregate by X [column]"
 * FIRST-match-wins. Runs after revert and before the pivot patterns.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import { logger } from "../../logger.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectAggregate(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { message, lowerMessage, availableColumns } = ctx;

  // Pattern: "aggregate X, group by Y, order by Z DESC" (e.g., "aggregate risk value, group by SKU Desc, order by risk value DESC")
  if (lowerMessage.includes('aggregate') && (lowerMessage.includes('group by') || lowerMessage.includes('groupby'))) {
    // Extract aggregation columns (before "group by")
    const groupByMatch = message.match(/\baggregate\s+(.+?)\s*,\s*group\s+by\s+/i) ||
                         message.match(/\baggregate\s+(.+?)\s+group\s+by\s+/i);

    if (groupByMatch) {
      const rawAggCols = groupByMatch[1]!.trim();
      const aggColumns = rawAggCols.split(',').map(c => {
        const col = c.trim();
        return findMentionedColumn(col, availableColumns) || col;
      });

      // Extract group by column (between "group by" and "order by" or end)
      const orderByMatch = message.match(/group\s+by\s+([^,]+?)(?:\s*,\s*order\s+by|$)/i);
      let groupByColumn: string | undefined;
      if (orderByMatch) {
        const rawGroupBy = orderByMatch[1]!.trim();
        groupByColumn = findMentionedColumn(rawGroupBy, availableColumns) || rawGroupBy;
      }

      // Extract order by column and direction
      const orderByRegex = /order\s+by\s+([a-zA-Z0-9_\s]+?)(?:\s+(asc|desc|ascending|descending))?/i;
      const orderByMatch2 = message.match(orderByRegex);
      let orderByColumn: string | undefined;
      let orderByDirection: 'asc' | 'desc' = 'asc';

      if (orderByMatch2) {
        const rawOrderBy = orderByMatch2[1]!.trim();
        orderByColumn = findMentionedColumn(rawOrderBy, availableColumns) || rawOrderBy;
        const direction = orderByMatch2[2]?.toLowerCase();
        if (direction === 'desc' || direction === 'descending') {
          orderByDirection = 'desc';
        }
      }

      if (groupByColumn && aggColumns.length > 0) {
        logger.log(`✅ Matched aggregate with group by: ${aggColumns.join(', ')} grouped by ${groupByColumn}${orderByColumn ? `, ordered by ${orderByColumn} ${orderByDirection}` : ''}`);
        return {
          operation: 'aggregate',
          groupByColumn,
          aggColumns,
          orderByColumn,
          orderByDirection,
          requiresClarification: false,
        };
      }
    }
  }

  // Pattern: "aggregate X on Y" (e.g., "aggregate RISK_VOLUME on DEPOT")
  // More flexible pattern to handle various formats including underscores
  const aggregateOnRegex = /\baggregate\s+([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)\s+on\s+([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)(?:\s|$|\.|,)/i;
  const aggregateOnMatch = aggregateOnRegex.exec(message);
  if (aggregateOnMatch) {
    const rawAggColumn = aggregateOnMatch[1]!.trim();
    const rawGroupBy = aggregateOnMatch[2]!.trim();

    const aggColumn = findMentionedColumn(rawAggColumn, availableColumns) || rawAggColumn;
    const groupByColumn = findMentionedColumn(rawGroupBy, availableColumns) || rawGroupBy;

    logger.log(`✅ Regex matched aggregate pattern: aggregate ${aggColumn} on ${groupByColumn}`);
    return {
      operation: 'aggregate',
      groupByColumn,
      aggColumns: [aggColumn],
      requiresClarification: false,
    };
  }

  // Simpler catch-all: if message contains "aggregate" and "on", try to extract columns
  if (lowerMessage.includes('aggregate') && lowerMessage.includes(' on ')) {
    const parts = message.split(/\s+on\s+/i);
    if (parts.length === 2) {
      const beforeOn = parts[0]!.replace(/^aggregate\s+/i, '').trim();
      const afterOn = parts[1]!.split(/\s|,|\./)[0]!.trim(); // Take first word after "on"

      if (beforeOn && afterOn) {
        const aggColumn = findMentionedColumn(beforeOn, availableColumns) || beforeOn;
        const groupByColumn = findMentionedColumn(afterOn, availableColumns) || afterOn;

        logger.log(`✅ Fallback pattern matched: aggregate ${aggColumn} on ${groupByColumn}`);
        return {
          operation: 'aggregate',
          groupByColumn,
          aggColumns: [aggColumn],
          requiresClarification: false,
        };
      }
    }
  }

  // Pattern: "aggregate all the other columns by X" or "aggregate all columns by X"
  // Use a more flexible pattern that captures everything between "by" and "using" (or end of string)
  const aggregateAllColumnsPattern = /\baggregate\s+(?:all\s+(?:the\s+other\s+)?columns?|all\s+other\s+columns?)\s+by\s+(.+?)(?:\s+using\s+(sum|avg|mean|min|max|count))?$/i;
  const aggregateAllColumnsMatch = aggregateAllColumnsPattern.exec(message);
  if (aggregateAllColumnsMatch) {
    const rawGroupBy = aggregateAllColumnsMatch[1]!.trim();
    const aggFunc = (aggregateAllColumnsMatch[2] || 'sum').toLowerCase() as 'sum' | 'avg' | 'mean' | 'min' | 'max' | 'count';

    // Try to find the column in available columns first
    let groupByColumn = findMentionedColumn(rawGroupBy, availableColumns);

    // If not found and rawGroupBy is suspiciously short, search in message context
    if (!groupByColumn && rawGroupBy.length < 3) {
      const messageLower = message.toLowerCase();
      const byIndex = messageLower.indexOf(' by ');
      const usingIndex = messageLower.indexOf(' using ');
      const endIndex = usingIndex !== -1 ? usingIndex : message.length;

      if (byIndex !== -1) {
        const betweenByAndUsing = message.substring(byIndex + 4, endIndex).trim();
        logger.log(`🔍 Searching for column in context: "${betweenByAndUsing}"`);

        // Try to find a column that matches this text
        for (const col of availableColumns) {
          const colLower = col.toLowerCase();
          if (betweenByAndUsing.toLowerCase().includes(colLower) || colLower.includes(betweenByAndUsing.toLowerCase())) {
            groupByColumn = col;
            logger.log(`✅ Found column "${col}" in message context`);
            break;
          }
        }
      }
    }

    groupByColumn = groupByColumn || rawGroupBy;

    logger.log(`✅ Regex matched aggregate all columns pattern: aggregate all columns by ${groupByColumn} using ${aggFunc}`);
    logger.log(`📋 Extracted rawGroupBy: "${rawGroupBy}", matched to: "${groupByColumn}"`);
    return {
      operation: 'aggregate',
      groupByColumn,
      aggColumns: undefined, // undefined means auto-detect all numeric columns
      aggFunc: aggFunc,
      requiresClarification: false,
    };
  }

  // Pattern: "aggregate over X" or "aggregate the whole data over X" or "aggregate all data over X"
  const aggregateOverRegex = /\baggregate\s+(?:the\s+whole\s+data|all\s+data|whole\s+data)?\s+over\s+([a-zA-Z0-9_ ]+?)(?:\s+column)?(?:\?|$)/i;
  const aggregateOverMatch = aggregateOverRegex.exec(message);
  if (aggregateOverMatch) {
    const rawGroupBy = aggregateOverMatch[1]!.trim();
    const groupByColumn =
      findMentionedColumn(rawGroupBy, availableColumns) || rawGroupBy;

    logger.log(`✅ Regex matched aggregate over pattern: aggregate over ${groupByColumn}`);
    return {
      operation: 'aggregate',
      groupByColumn,
      aggColumns: undefined, // undefined means auto-detect all numeric columns
      requiresClarification: false,
    };
  }

  // Pattern: "aggregate X by Y using sum" - explicit column and function
  // Use a more precise pattern that captures full words/column names
  const aggregateByUsingPattern = /\baggregate\s+([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)\s+by\s+([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)\s+using\s+(sum|avg|mean|min|max|count)/i;
  const aggregateByUsingMatch = aggregateByUsingPattern.exec(message);
  if (aggregateByUsingMatch) {
    const rawAggColumn = aggregateByUsingMatch[1]!.trim();
    const rawGroupByColumn = aggregateByUsingMatch[2]!.trim();
    const aggFunc = (aggregateByUsingMatch[3] || 'sum').toLowerCase() as 'sum' | 'avg' | 'mean' | 'min' | 'max' | 'count';

    // Try to match columns from available columns list
    let matchedAggCol = findMentionedColumn(rawAggColumn, availableColumns);
    let matchedGroupBy = findMentionedColumn(rawGroupByColumn, availableColumns);

    // If groupBy wasn't found, try searching in the original message context
    if (!matchedGroupBy) {
      const messageLower = message.toLowerCase();
      const byIndex = messageLower.indexOf(' by ');
      const usingIndex = messageLower.indexOf(' using ');
      const endIndex = usingIndex !== -1 ? usingIndex : message.length;

      if (byIndex !== -1) {
        const betweenByAndUsing = message.substring(byIndex + 4, endIndex).trim();
        logger.log(`🔍 Column not found via findMentionedColumn, searching in context: "${betweenByAndUsing}"`);

        // Try to find a column that matches this text (case-insensitive, word boundary aware)
        for (const col of availableColumns) {
          const colLower = col.toLowerCase();
          const contextLower = betweenByAndUsing.toLowerCase();

          // Check if column name appears in context or vice versa
          if (contextLower.includes(colLower) || colLower.includes(contextLower)) {
            // Prefer exact match or longer column name
            if (contextLower === colLower || colLower.length >= contextLower.length) {
              matchedGroupBy = col;
              logger.log(`✅ Found column "${col}" in message context`);
              break;
            }
          }
        }
      }
    }

    // Fallback: use extracted values if no match found
    matchedAggCol = matchedAggCol || rawAggColumn;
    matchedGroupBy = matchedGroupBy || rawGroupByColumn;

    logger.log(`✅ Regex matched aggregate pattern: aggregate ${matchedAggCol} by ${matchedGroupBy} using ${aggFunc}`);
    logger.log(`📋 Extracted: rawAggColumn="${rawAggColumn}", rawGroupByColumn="${rawGroupByColumn}" -> matched: "${matchedGroupBy}"`);
    return {
      operation: 'aggregate',
      groupByColumn: matchedGroupBy,
      aggColumns: [matchedAggCol],
      aggFunc: aggFunc,
      requiresClarification: false,
    };
  }

  // Pattern: "aggregate by X column" or "aggregate by X"
  const aggregateByRegex = /\baggregate\s+by\s+([a-zA-Z0-9_ ]+?)(?:\s+column|\?|$)/i;
  const aggregateMatch = aggregateByRegex.exec(message);
  if (aggregateMatch) {
    const rawGroupBy = aggregateMatch[1]!.trim();
    const groupByColumn =
      findMentionedColumn(rawGroupBy, availableColumns) || rawGroupBy;

    return {
      operation: 'aggregate',
      groupByColumn,
      requiresClarification: false,
    };
  }

  return null;
}
