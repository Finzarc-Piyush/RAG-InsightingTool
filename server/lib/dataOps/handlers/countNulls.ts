/**
 * `count_nulls` data-op handler — extracted verbatim from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure read-only operation: counts null/missing values in one column or across
 * all columns. No persistence, no preview, no session-document mutation — so it
 * depends only on the row data and the target column. Behaviour-preserving move.
 */
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";

export interface CountNullsArgs {
  data: DataRow[];
  /** Specific column to count nulls in; omit/undefined → count across all columns. */
  column?: string;
}

export function handleCountNulls({ data, column }: CountNullsArgs): DataOpResult {
  // Count null values in data
  let nullCount = 0;
  let columnNulls: Array<{ column: string; count: number }> = [];

  if (column) {
    // Count nulls in specific column
    const columnNullCount = data.filter(row =>
      row[column!] === null ||
      row[column!] === undefined ||
      row[column!] === ''
    ).length;
    nullCount = columnNullCount;

    return {
      answer: `There are ${nullCount} null/missing values in the "${column}" column out of ${data.length} total rows.`
    };
  } else {
    // Count nulls across all columns
    const columns = Object.keys(data[0] || {});
    columnNulls = columns.map(col => {
      const count = data.filter(row =>
        row[col] === null || row[col] === undefined || row[col] === ''
      ).length;
      return { column: col, count };
    });

    nullCount = columnNulls.reduce((sum, item) => sum + item.count, 0);
    const columnsWithNulls = columnNulls.filter(item => item.count > 0);

    if (columnsWithNulls.length === 0) {
      return {
        answer: `Great! There are no null or missing values in your dataset. All ${data.length} rows have complete data across all ${columns.length} columns.`
      };
    } else {
      const nullDetails = columnsWithNulls
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map(item => `  • ${item.column}: ${item.count} null${item.count !== 1 ? 's' : ''}`)
        .join('\n');

      const moreText = columnsWithNulls.length > 10
        ? `\n  ... and ${columnsWithNulls.length - 10} more column(s) with nulls`
        : '';

      return {
        answer: `There are ${nullCount} null/missing value(s) in your dataset across ${columnsWithNulls.length} column(s) out of ${columns.length} total columns.\n\nColumns with null values:\n${nullDetails}${moreText}\n\nTotal rows: ${data.length}`
      };
    }
  }
}
