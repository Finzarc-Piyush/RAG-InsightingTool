/**
 * `describe` data-op handler — extracted verbatim from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure read-only operation: produces a conversational description of the
 * dataset (row/column counts, null counts, simple type inference). No
 * persistence, no preview, no session-document mutation — depends only on the
 * row data. Behaviour-preserving move.
 */
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";

export interface DescribeArgs {
  data: DataRow[];
}

export function handleDescribe({ data }: DescribeArgs): DataOpResult {
  // Provide conversational description of the data
  const totalRows = data.length;
  const columns = Object.keys(data[0] || {});
  const totalColumns = columns.length;

  // Count nulls
  const nullCounts = columns.map(col => ({
    column: col,
    count: data.filter(row => row[col] === null || row[col] === undefined || row[col] === '').length
  }));
  const totalNulls = nullCounts.reduce((sum, item) => sum + item.count, 0);
  const columnsWithNulls = nullCounts.filter(item => item.count > 0).length;

  // Get data types (simple inference)
  const columnTypes = columns.map(col => {
    const sampleValues = data.slice(0, 100).map(row => row[col]).filter(v => v != null);
    if (sampleValues.length === 0) return 'unknown';

    const firstValue = sampleValues[0];
    if (typeof firstValue === 'number') return 'numeric';
    if (typeof firstValue === 'boolean') return 'boolean';
    if (firstValue instanceof Date || (typeof firstValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(firstValue))) return 'date';
    return 'text';
  });

  const numericCols = columns.filter((col, idx) => columnTypes[idx] === 'numeric').length;
  const textCols = columns.filter((col, idx) => columnTypes[idx] === 'text').length;
  const dateCols = columns.filter((col, idx) => columnTypes[idx] === 'date').length;

  let answer = `Your dataset contains:\n`;
  answer += `  • **${totalRows.toLocaleString()} rows** of data\n`;
  answer += `  • **${totalColumns} columns**: ${numericCols} numeric, ${textCols} text, ${dateCols} date\n`;

  if (totalNulls > 0) {
    answer += `  • **${totalNulls.toLocaleString()} null/missing values** across ${columnsWithNulls} column(s)\n`;
  } else {
    answer += `  • **No null or missing values** - complete dataset! ✅\n`;
  }

  answer += `\nColumn names: ${columns.slice(0, 10).join(', ')}${columns.length > 10 ? `, ... and ${columns.length - 10} more` : ''}`;

  return {
    answer
  };
}
