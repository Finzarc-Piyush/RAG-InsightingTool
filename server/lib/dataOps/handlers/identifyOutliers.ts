/**
 * `identify_outliers` data-op handler — extracted verbatim from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Read-only operation: delegates to the Python service `identifyOutliers` and
 * formats a textual report. Does NOT modify data (`saved: false`), no preview,
 * no session-document mutation. Depends only on the row data and the
 * outlier-detection fields of the intent. Behaviour-preserving move.
 */
import { identifyOutliers } from "../pythonService.js";
import { logger } from "../../logger.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";

export interface IdentifyOutliersArgs {
  data: DataRow[];
  column?: string;
  outlierMethod?: 'iqr' | 'zscore' | 'isolation_forest' | 'local_outlier_factor';
  outlierThreshold?: number;
}

export async function handleIdentifyOutliers({
  data,
  column,
  outlierMethod,
  outlierThreshold,
}: IdentifyOutliersArgs): Promise<DataOpResult> {
  // Validate input data
  if (!data || data.length === 0) {
    return {
      answer: '❌ No data available to process. Please ensure your dataset has been loaded correctly.',
    };
  }

  try {
    const method = outlierMethod || 'iqr';
    const threshold = outlierThreshold || (method === 'zscore' ? 3 : 1.5);

    const result = await identifyOutliers(
      data,
      column,
      method,
      threshold
    );

    // Format response
    let answer = `📊 Outlier Analysis Results:\n\n`;
    answer += `**Method Used:** ${method.toUpperCase()}\n`;
    answer += `**Threshold:** ${threshold}\n`;
    answer += `**Total Outliers Found:** ${result.summary.total_outliers}\n\n`;

    if (result.summary.outliers_by_column && Object.keys(result.summary.outliers_by_column).length > 0) {
      answer += `**Outliers by Column:**\n`;
      Object.entries(result.summary.outliers_by_column).forEach(([col, count]) => {
        answer += `- ${col}: ${count} outlier(s)\n`;
      });
      answer += `\n`;
    }

    if (result.outliers.length > 0) {
      answer += `**Outlier Details (showing first 20):**\n`;
      result.outliers.slice(0, 20).forEach((outlier, idx) => {
        answer += `${idx + 1}. Row ${outlier.row_index + 1}, Column "${outlier.column}": ${outlier.value}`;
        if (outlier.z_score !== undefined) {
          answer += ` (z-score: ${outlier.z_score.toFixed(2)})`;
        }
        if (outlier.iqr_lower !== undefined && outlier.iqr_upper !== undefined) {
          answer += ` (bounds: ${outlier.iqr_lower.toFixed(2)} - ${outlier.iqr_upper.toFixed(2)})`;
        }
        answer += `\n`;
      });

      if (result.outliers.length > 20) {
        answer += `\n... and ${result.outliers.length - 20} more outliers.\n`;
      }

      answer += `\n💡 Would you like me to treat these outliers? I can remove them, cap them, or replace them with mean/median values.`;
    } else {
      answer += `✅ No outliers detected using the ${method} method with threshold ${threshold}.`;
    }

    return {
      answer,
      saved: false, // Identification doesn't modify data
    };
  } catch (error) {
    logger.error('Outlier identification error:', error);
    return {
      answer: `Failed to identify outliers: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
    };
  }
}
