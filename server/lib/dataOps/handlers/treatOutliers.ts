/**
 * `treat_outliers` data-op handler — extracted VERBATIM from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Delegates outlier treatment to the Python service (`treatOutliers`), persists
 * the modified table via `saveModifiedData`, formats a textual report, and
 * returns a row-level preview from the saved data. A data-modification op:
 * returns `{ answer, data, preview, saved: true }`. The body below is moved
 * unchanged from the orchestrator — same pythonService call, same save, same
 * answer strings, same return shape; the only change is collapsing the branch's
 * captured locals into a single typed args object (CQ-2).
 */
import { treatOutliers } from "../pythonService.js";
import { saveModifiedData, getPreviewFromSavedData } from "../dataPersistence.js";
import { logger } from "../../logger.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

export interface TreatOutliersArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionId: string;
  sessionDoc?: ChatDocument;
}

export async function handleTreatOutliers({
  intent,
  data,
  sessionId,
  sessionDoc,
}: TreatOutliersArgs): Promise<DataOpResult> {
  // Validate input data
  if (!data || data.length === 0) {
    return {
      answer: '❌ No data available to process. Please ensure your dataset has been loaded correctly.',
    };
  }

  try {
    const method = intent.outlierMethod || 'iqr';
    const threshold = intent.outlierThreshold || (method === 'zscore' ? 3 : 1.5);
    const treatment = intent.treatmentMethod || 'remove';
    const treatmentValue = intent.treatmentValue;

    logger.log(`🔍 Outlier treatment parameters:`, {
      method,
      threshold,
      treatment,
      treatmentValue,
      column: intent.column
    });

    const result = await treatOutliers(
      data,
      intent.column,
      method,
      threshold,
      treatment,
      treatmentValue
    );

    // Save modified data
    const saveResult = await saveModifiedData(
      sessionId,
      result.data,
      'treat_outliers',
      `Treated ${result.outliers_treated} outliers using ${method} method with ${treatment} treatment`,
      sessionDoc
    );

    // Format response
    let answer = `✅ Successfully treated outliers:\n\n`;
    answer += `**Method:** ${method.toUpperCase()}\n`;
    answer += `**Treatment:** ${treatment}\n`;
    if (treatmentValue) {
      answer += `**Treatment Value:** ${treatmentValue}\n`;
    }
    answer += `**Outliers Treated:** ${result.outliers_treated}\n`;
    answer += `**Rows:** ${result.rows_before} → ${result.rows_after}\n`;

    if (result.summary.outliers_by_column && Object.keys(result.summary.outliers_by_column).length > 0) {
      answer += `\n**Treated by Column:**\n`;
      Object.entries(result.summary.outliers_by_column).forEach(([col, count]) => {
        answer += `- ${col}: ${count} outlier(s)\n`;
      });
    }

    // Get preview from saved data
    const previewData = await getPreviewFromSavedData(sessionId, result.data);

    return {
      answer,
      data: result.data,
      preview: previewData,
      saved: true,
    };
  } catch (error) {
    logger.error('Outlier treatment error:', error);
    return {
      answer: `Failed to treat outliers: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
    };
  }
}
