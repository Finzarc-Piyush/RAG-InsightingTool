/**
 * `pivot` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Delegates pivot-table creation to the Python service (`createPivotTable`),
 * then returns the pivoted table as `data` plus a NON-DESTRUCTIVE row-level
 * slice of the input as `preview`. Handles the large-buffer path (a >50MB pivot
 * is returned in-response without persisting the pivoted shape to the session
 * blob). Does NOT persist to the session blob and does NOT mutate the chat
 * document (`saved: false`). The body below is moved unchanged from the
 * orchestrator — same pythonService call, same answer strings, same return
 * shape; the only change is collapsing the branch's captured locals into a
 * single typed args object (CQ-2).
 */
import { createPivotTable } from "../pythonService.js";
import { findMentionedColumn } from "../dataOpsValueHelpers.js";
import { logger } from "../../logger.js";
import { errorMessage } from "../../../utils/errorMessage.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

// Local constant mirrored from the orchestrator (row-level preview cap).
const ROW_LEVEL_PREVIEW_MAX_ROWS = 500;

export interface PivotArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  originalMessage?: string;
}

export async function handlePivot({
  intent,
  data,
  originalMessage,
}: PivotArgs): Promise<DataOpResult> {
  // Use Python service for pivot table creation
  const indexCol =
    intent.pivotIndex ||
    intent.groupByColumn ||
    intent.column ||
    findMentionedColumn(originalMessage || '', Object.keys(data[0] || {}));

  if (!indexCol) {
    return {
      answer:
        'Please specify which column to use as the pivot index. For example: "Create a pivot on Brand showing Sales, Spend, ROI fields".',
    };
  }

  if (data.length > 0 && !(indexCol in data[0]!)) {
    return {
      answer: `Column "${indexCol}" was not found. Available columns: ${Object.keys(
        data[0] || {},
      ).join(', ')}`,
    };
  }

  const allColumns = Object.keys(data[0] || {});
  const valueColumns =
    intent.pivotValues && intent.pivotValues.length > 0
      ? intent.pivotValues
      : allColumns.filter(c => c !== indexCol);

  if (valueColumns.length === 0) {
    return {
      answer: `Please specify at least one value column for the pivot (e.g., "showing Sales, Spend").`,
    };
  }

  try {
    logger.log(`🔄 Starting pivot operation: indexCol="${indexCol}", valueColumns=[${valueColumns.join(', ')}]`);
    logger.log(`📊 Input data: ${data.length} rows`);
    if (data.length > 0) {
      logger.log(`📊 Input columns: ${Object.keys(data[0]!).join(', ')}`);
      logger.log(`📊 Sample input row:`, JSON.stringify(data[0], null, 2));
    }

    // Call Python service for pivot table
    const result = await createPivotTable(
      data,
      indexCol,
      valueColumns,
      intent.pivotFuncs
    );

    logger.log(`✅ Python service returned pivot result:`);
    logger.log(`   - rows_before: ${result.rows_before}`);
    logger.log(`   - rows_after: ${result.rows_after}`);
    logger.log(`   - data length: ${result.data?.length || 0}`);
    logger.log(`   - has large file buffer: ${!!(result as any)._largeFileBuffer}`);

    const pivotData = result.data || [];
    const rowsBefore = result.rows_before;
    const rowsAfter = result.rows_after;
    const largeFileBuffer = (result as any)._largeFileBuffer as Buffer | undefined;

    // Large in-memory pivot result: do not overwrite session blob with pivoted shape (non-destructive).
    if (largeFileBuffer) {
      logger.log(
        `📊 Large pivot table (${(largeFileBuffer.length / 1024 / 1024).toFixed(2)}MB buffer). Returning pivot in response without persisting to blob.`
      );

      const uniquePivotValues = new Set<string>();
      if (pivotData.length > 0) {
        const firstRow = pivotData[0]!;
        Object.keys(firstRow).forEach((key) => {
          if (key.includes('_') && key !== indexCol) {
            const parts = key.split('_');
            if (parts.length > 1) {
              uniquePivotValues.add(parts.slice(1).join('_'));
            }
          }
        });
      }

      const pivotValuesText =
        uniquePivotValues.size > 0
          ? Array.from(uniquePivotValues).slice(0, 3).join(', ') +
            (uniquePivotValues.size > 3 ? '...' : '')
          : 'various values';

      let answer = `✅ I've created a pivot table on "${indexCol}".`;
      answer += ` The values from "${indexCol}" (${pivotValuesText}) have been converted into separate columns.`;
      answer += ` All other columns have been preserved.`;
      answer += ` The result has ${rowsAfter} row${rowsAfter === 1 ? '' : 's'} (down from ${rowsBefore}).`;
      answer += ` Your full dataset in this session is unchanged so you can keep exploring dimensions.`;

      const previewData =
        data.length > 0
          ? data.slice(0, Math.min(ROW_LEVEL_PREVIEW_MAX_ROWS, data.length))
          : [];

      return {
        answer,
        data: pivotData,
        preview: previewData,
        saved: false,
      };
    }

    // Normal flow for smaller pivot tables
    if (!pivotData || pivotData.length === 0) {
      logger.error(`❌ Pivot returned empty data!`);
      return {
        answer: `Error: Pivot operation returned no data. Please check your data and try again.`,
      };
    }

    logger.log(`📊 Pivot data details:`);
    logger.log(`   - Total rows: ${pivotData.length}`);
    logger.log(`   - Columns: ${Object.keys(pivotData[0] || {}).join(', ')}`);
    if (pivotData.length > 0) {
      logger.log(`   - Sample pivot row:`, JSON.stringify(pivotData[0], null, 2));
      if (pivotData.length > 1) {
        logger.log(`   - Second pivot row:`, JSON.stringify(pivotData[1], null, 2));
      }
    }

    // Do not persist pivoted tables to session blob (non-destructive); chat preview uses row-level rows.

    // Get unique values from the pivot column to show in the answer
    const uniquePivotValues = new Set<string>();
    if (pivotData.length > 0) {
      const firstRow = pivotData[0]!;
      // Find columns that contain the pivot index column name (these are the pivoted columns)
      Object.keys(firstRow).forEach(key => {
        if (key.includes('_') && key !== indexCol) {
          // Extract the pivot value from column names like "Sales_Complete" -> "Complete"
          const parts = key.split('_');
          if (parts.length > 1) {
            uniquePivotValues.add(parts.slice(1).join('_'));
          }
        }
      });
    }

    const pivotValuesText = uniquePivotValues.size > 0
      ? Array.from(uniquePivotValues).slice(0, 3).join(', ') + (uniquePivotValues.size > 3 ? '...' : '')
      : 'various values';

    let answer = `✅ I've created a pivot table on "${indexCol}".`;
    answer += ` The values from "${indexCol}" (${pivotValuesText}) have been converted into separate columns.`;
    answer += ` All other columns have been preserved.`;
    answer += ` The result has ${rowsAfter} row${rowsAfter === 1 ? '' : 's'} (down from ${rowsBefore}).`;
    answer += ` Your full dataset in this session is unchanged so you can keep exploring dimensions.`;

    const previewData =
      data.length > 0
        ? data.slice(0, Math.min(ROW_LEVEL_PREVIEW_MAX_ROWS, data.length))
        : [];

    logger.log(`✅ Pivot complete: ${rowsAfter} rows, row-level preview ${previewData.length} rows`);
    if (previewData.length > 0) {
      logger.log(`📊 Row-level preview columns: ${Object.keys(previewData[0]!).join(', ')}`);
      logger.log(`📊 Row-level sample row:`, JSON.stringify(previewData[0], null, 2));
    } else {
      logger.warn(`⚠️ No row-level preview — input data was empty`);
    }

    logger.log(`📤 Returning pivot result: answer length=${answer.length}, preview rows=${previewData.length}, saved=false`);

    return {
      answer,
      data: pivotData,
      preview: previewData,
      saved: false,
    };
  } catch (error) {
    logger.error('❌ Error calling Python service for pivot:', error);
    logger.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    return {
      answer: `Error during pivot creation: ${errorMessage(error)}. Please try again.`,
    };
  }
}
