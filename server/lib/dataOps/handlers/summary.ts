/**
 * `summary` data-op handler — extracted verbatim from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Read-only operation: delegates to the Python service `getDataSummary` and
 * shapes the result for one column or all columns. No persistence, no preview,
 * no session-document mutation. Behaviour-preserving move.
 */
import { getDataSummary } from "../pythonService.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";

export interface SummaryArgs {
  data: DataRow[];
  /** Specific column to summarise; omit/undefined → summarise all columns. */
  column?: string;
}

export async function handleSummary({ data, column }: SummaryArgs): Promise<DataOpResult> {
  const result = await getDataSummary(data, column);

  if (column) {
    // Single column summary
    const columnSummary = result.summary.find((s) => s.variable === column);
    if (columnSummary) {
      return {
        answer: `Here's a summary for column "${column}":`,
        summary: [columnSummary] // Return as array with single item for consistency
      };
    } else {
      return {
        answer: `Column "${column}" not found. Here's a summary of all columns:`,
        summary: result.summary
      };
    }
  } else {
    // All columns summary
    return {
      answer: 'Here\'s a summary of your data:',
      summary: result.summary
    };
  }
}
