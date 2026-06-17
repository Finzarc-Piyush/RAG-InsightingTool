/**
 * `aggregate` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Delegates aggregation to the Python service (`aggregateData`), then returns
 * the aggregated table as `data` plus a NON-DESTRUCTIVE row-level slice of the
 * input as `preview` (so the pivot UI keeps the original dimensions). Does NOT
 * persist to the session blob and does NOT mutate the chat document
 * (`saved: false`). The body below is moved unchanged from the orchestrator —
 * same pythonService call, same answer strings, same return shape; the only
 * change is collapsing the branch's captured locals into a single typed args
 * object (CQ-2).
 */
import { aggregateData } from "../pythonService.js";
import {
  applyTemporalFacetColumns,
  periodDimensionFromSummary,
  remapGroupByToTemporalFacet,
} from "../../temporalFacetColumns.js";
import { coerceTemporalFacetKeysToStrings } from "../../temporalFacetKeyNormalization.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import { logger } from "../../logger.js";
import { errorMessage } from "../../../utils/errorMessage.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

// Local constant mirrored from the orchestrator (row-level preview cap).
const ROW_LEVEL_PREVIEW_MAX_ROWS = 500;

export interface AggregateArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionDoc?: ChatDocument;
  originalMessage?: string;
}

export async function handleAggregate({
  intent,
  data,
  sessionDoc,
  originalMessage,
}: AggregateArgs): Promise<DataOpResult> {
  // Use Python service for aggregation
  const groupBy =
    intent.groupByColumn ||
    intent.column ||
    findMentionedColumn(originalMessage || '', Object.keys(data[0] || {}));

  if (!groupBy) {
    return {
      answer:
        'Please specify which column to aggregate by. For example: "Aggregate by Month column".',
    };
  }

  const dateColsForFacets = sessionDoc?.dataSummary?.dateColumns ?? [];
  if (data.length > 0 && dateColsForFacets.length > 0) {
    applyTemporalFacetColumns(data, dateColsForFacets, {
      periodDimension: periodDimensionFromSummary(sessionDoc?.dataSummary),
    });
  }


  if (data.length > 0 && !(groupBy in data[0]!)) {
    return {
      answer: `Column "${groupBy}" was not found. Available columns: ${Object.keys(
        data[0] || {},
      ).join(', ')}`,
    };
  }

  try {
    const keys = new Set(Object.keys(data[0] || {}));
    const { groupBy: remappedGroupBy, remapped } = remapGroupByToTemporalFacet({
      groupByColumn: groupBy,
      dateColumns: dateColsForFacets,
      originalMessage,
      availableKeys: keys,
    });
    const effectiveGroupBy =
      remapped && keys.has(remappedGroupBy) ? remappedGroupBy : groupBy;
    if (remapped && effectiveGroupBy !== groupBy) {
      logger.log(
        `📅 Remapped aggregate groupBy "${groupBy}" → "${effectiveGroupBy}" (coarse calendar bucket)`
      );
    }

    // If aggColumns is empty array or undefined, pass undefined to Python service for auto-detection
    const aggColumnsForPython = (intent.aggColumns && intent.aggColumns.length > 0) ? intent.aggColumns : undefined;

    logger.log(`📊 Aggregating by "${effectiveGroupBy}". aggColumns: ${aggColumnsForPython ? JSON.stringify(aggColumnsForPython) : 'undefined (auto-detect all numeric columns)'}`);

    // Call Python service for aggregation
    // Pass original message for semantic intent detection (average, median, highest, etc.)
    const result = await aggregateData(
      data,
      effectiveGroupBy,
      aggColumnsForPython,
      intent.aggFuncs,
      intent.orderByColumn,
      intent.orderByDirection,
      originalMessage  // Pass user's original message for semantic analysis
    );

    const aggregatedData = result.data;
    const rowsBefore = result.rows_before;
    const rowsAfter = result.rows_after;

    // Defensive: temporal facet bucket keys (UI or legacy __tf_*) must remain
    // categorical strings. If any upstream step coerces them to numbers,
    // the UI may format them like measures (e.g. `2015` -> `2,015`).
    coerceTemporalFacetKeysToStrings(aggregatedData);

    const numericColCount = Object.keys(aggregatedData[0] || {}).filter(k => k.includes('(Sum)') || k.includes('(Avg)') || k.includes('(Min)') || k.includes('(Max)') || k.includes('(Count)')).length;

    // Do not persist aggregated-only tables: they drop non-grouped dimensions (e.g. City) and would
    // clobber the session row-level dataset. Charts / answer use `data` (aggregated); chat preview uses
    // a row-level slice so the analysis pivot can add dimensions from the original facts.

    let answer =
      effectiveGroupBy !== groupBy
        ? `✅ I've created a new aggregated table grouped by calendar bucket column "${effectiveGroupBy}" (from date column "${groupBy}").`
        : `✅ I've created a new aggregated table grouped by "${effectiveGroupBy}".`;
    answer += ` Aggregated ${numericColCount} numeric column${numericColCount === 1 ? '' : 's'} (excluding ID columns and string columns).`;
    answer += ` The result has ${rowsAfter} row${rowsAfter === 1 ? '' : 's'} (down from ${rowsBefore}).`;
    answer += ` Your full dataset in this session is unchanged so you can explore other dimensions in the pivot.`;
    if (intent.orderByColumn) {
      answer += ` Results are sorted by ${intent.orderByColumn} ${intent.orderByDirection === 'desc' ? 'descending' : 'ascending'}.`;
    }

    // Row-level preview (input to aggregation) so pivot UI retains City and other dims
    const previewData =
      data.length > 0 ? data.slice(0, Math.min(ROW_LEVEL_PREVIEW_MAX_ROWS, data.length)) : [];

    logger.log(`✅ Aggregation complete: ${rowsAfter} rows, showing preview of ${previewData.length} rows`);
    if (previewData.length > 0) {
      logger.log(`📊 Preview columns: ${Object.keys(previewData[0]!).join(', ')}`);
      logger.log(`📊 Sample row:`, JSON.stringify(previewData[0], null, 2));
    } else {
      logger.warn(`⚠️ No preview data available - aggregatedData is empty`);
    }

    return {
      answer,
      data: aggregatedData, // Aggregated result for charts / downstream tooling
      preview: previewData, // Row-level slice for chat / pivot (non-destructive)
      saved: false,
    };
  } catch (error) {
    logger.error('Error calling Python service for aggregation:', error);
    return {
      answer: `Error during aggregation: ${errorMessage(error)}. Please try again.`,
    };
  }
}
