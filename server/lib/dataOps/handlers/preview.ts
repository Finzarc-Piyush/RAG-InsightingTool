/**
 * `preview` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * The filter/preview display branch: optionally applies `filterConditions` for a
 * NON-DESTRUCTIVE preview (the dataset is never mutated or persisted), then
 * slices the (possibly filtered) rows per `previewMode` (range / last / specific /
 * first-N). Read-only — returns `{ answer, preview }` with no `data` and no
 * `saved`, no session-document mutation. The body below is moved unchanged from
 * the orchestrator; the only change is collapsing the captured locals into a
 * single typed args object (CQ-2).
 */
import { getDataPreview } from "../pythonService.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

export interface PreviewArgs {
  intent: DataOpsIntent;
  data: DataRow[];
}

export async function handlePreview({
  intent,
  data,
}: PreviewArgs): Promise<DataOpResult> {
  let previewData: DataRow[];
  let answer: string;
  let workingData = data; // Start with original data
  let filteredCount = 0;

  // CRITICAL: If filterConditions are present, apply them for preview ONLY
  // This is a preview with conditions - filter the data but DON'T save as working dataset
  if (intent.filterConditions && intent.filterConditions.length > 0) {
    const rowsBefore = workingData.length;
    workingData = workingData.filter(row => {
      const results = intent.filterConditions!.map(condition => {
        const { column, operator, value, value2, values } = condition;
        const cellValue = row[column];

        if (cellValue === null || cellValue === undefined) {
          return false; // Exclude null/undefined values from preview
        }

        switch (operator) {
          case '=':
            if (typeof cellValue === 'number' && typeof value === 'number') {
              return cellValue === value;
            }
            return String(cellValue).toLowerCase().trim() === String(value).toLowerCase().trim();
          case '!=':
            if (typeof cellValue === 'number' && typeof value === 'number') {
              return cellValue !== value;
            }
            return String(cellValue).toLowerCase().trim() !== String(value).toLowerCase().trim();
          case '>':
            return Number(cellValue) > Number(value);
          case '>=':
            return Number(cellValue) >= Number(value);
          case '<':
            return Number(cellValue) < Number(value);
          case '<=':
            return Number(cellValue) <= Number(value);
          case 'contains':
            return String(cellValue).toLowerCase().includes(String(value).toLowerCase());
          case 'startsWith':
            return String(cellValue).toLowerCase().startsWith(String(value).toLowerCase());
          case 'endsWith':
            return String(cellValue).toLowerCase().endsWith(String(value).toLowerCase());
          case 'between': {
            if (value2 === undefined || value2 === null) return false;
            const numValue = Number(cellValue);
            return numValue >= Number(value) && numValue <= Number(value2);
          }
          case 'in':
            if (!values || !Array.isArray(values)) return false;
            return values.some(v => {
              if (typeof cellValue === 'number' && typeof v === 'number') {
                return cellValue === v;
              }
              return String(cellValue).toLowerCase().trim() === String(v).toLowerCase().trim();
            });
          default:
            return true;
        }
      });

      const logicalOp = intent.logicalOperator || 'AND';
      return logicalOp === 'AND'
        ? results.every(r => r)
        : results.some(r => r);
    });

    filteredCount = workingData.length;
    const rowsRemoved = rowsBefore - filteredCount;

    if (filteredCount === 0) {
      return {
        answer: `⚠️ No rows match the specified conditions. The dataset has ${rowsBefore} total rows, but none match your filter criteria.`
      };
    }
  }

  // Now apply preview mode on the (possibly filtered) data
  if ((intent.previewMode === 'range' || (!intent.previewMode && intent.previewStartRow && intent.previewEndRow))
      && intent.previewStartRow && intent.previewEndRow) {
    // Show range of rows (1-based indices)
    const startIndex = intent.previewStartRow - 1;
    const endIndex = intent.previewEndRow; // slice is exclusive, so use endIndex directly
    if (startIndex >= 0 && startIndex < workingData.length && endIndex > startIndex && endIndex <= workingData.length) {
      previewData = workingData.slice(startIndex, endIndex);
      answer = `Showing rows ${intent.previewStartRow} to ${intent.previewEndRow} (${previewData.length} rows)${intent.filterConditions ? ` from ${filteredCount} matching rows` : ` of ${data.length} total rows`}:`;
    } else {
      return {
        answer: `Invalid range. Rows ${intent.previewStartRow} to ${intent.previewEndRow} are out of range. ${intent.filterConditions ? `There are ${filteredCount} matching rows.` : `The dataset has ${data.length} rows.`}`
      };
    }
  } else if (intent.previewMode === 'last') {
    // Show last N rows
    const limit = intent.limit || 50;
    const startIndex = Math.max(0, workingData.length - limit);
    previewData = workingData.slice(startIndex);
    answer = `Showing last ${previewData.length}${intent.filterConditions ? ` of ${filteredCount} matching rows` : ` of ${data.length} rows`}:`;
  } else if (intent.previewMode === 'specific' && intent.previewStartRow) {
    // Show specific row (1-based index)
    const rowIndex = intent.previewStartRow - 1;
    if (rowIndex >= 0 && rowIndex < workingData.length) {
      previewData = [workingData[rowIndex]!];
      answer = `Showing row ${intent.previewStartRow}${intent.filterConditions ? ` of ${filteredCount} matching rows` : ` of ${data.length} rows`}:`;
    } else {
      return {
        answer: `Row ${intent.previewStartRow} is out of range. ${intent.filterConditions ? `There are ${filteredCount} matching rows.` : `The dataset has ${data.length} rows.`}`
      };
    }
  } else {
    // Default: first N rows from (possibly filtered) data
    const limit = intent.limit || 50;
    const result = await getDataPreview(workingData, limit);
    previewData = result.data;
    const totalRows = intent.filterConditions ? filteredCount : result.total_rows;
    answer = `Showing ${result.returned_rows} of ${totalRows} rows${intent.filterConditions ? ' (filtered)' : ''}:`;
  }

  // Add note if conditions were applied (this is preview, not filter)
  if (intent.filterConditions && intent.filterConditions.length > 0) {
    const conditionDesc = intent.filterConditions.map(c => {
      const { column, operator, value, value2, values } = c;
      if (operator === 'between') {
        return `${column} between ${value} and ${value2}`;
      } else if (operator === 'in') {
        return `${column} in [${values?.join(', ')}]`;
      } else {
        return `${column} ${operator} ${value}`;
      }
    }).join(` ${intent.logicalOperator || 'AND'} `);
    answer += `\n\n📋 Filter conditions: ${conditionDesc}`;
    answer += `\n💡 This is a preview only. The dataset has not been filtered. To filter the dataset, use "filter data where..."`;
  }

  return {
    answer,
    preview: previewData
  };
}
