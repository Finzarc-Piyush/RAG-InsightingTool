/**
 * `revert` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Restores the dataset to its original uploaded form: loads the original file
 * from blob, parses it, re-applies the wide-format melt that ran at upload
 * (WPF4) so the long analytical canonical is returned (not the raw wide buffer),
 * converts "-" → 0 for numeric columns, persists via `saveModifiedData`, clears
 * the active filter (Wave-FA5), and returns a preview from the saved data. A
 * data-modification op: returns `{ answer, data, preview, saved: true }`. Guards
 * short-circuit when there is no session doc or no original blob.
 *
 * The body below is moved unchanged from the orchestrator — same dynamic
 * wide-format / active-filter imports, same save, same answer strings, same
 * return shape. The module-private `loadActiveFilterPersistModule` dynamic
 * import is inlined here (used only by filter / revert). The only change vs. the
 * orchestrator is collapsing the captured locals into a single typed args
 * object (CQ-2).
 */
import { saveModifiedData, getPreviewFromSavedData } from "../dataPersistence.js";
import { getFileFromBlob } from "../../blobStorage.js";
import { parseFile, convertDashToZeroForNumericColumns } from "../../fileParser.js";
import { logger } from "../../logger.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";

export interface RevertArgs {
  sessionId: string;
  sessionDoc?: ChatDocument;
}

export async function handleRevert({
  sessionId,
  sessionDoc,
}: RevertArgs): Promise<DataOpResult> {
  // Load original data from blob
  if (!sessionDoc) {
    return {
      answer: 'Unable to revert: session not found. Please refresh and try again.',
    };
  }

  if (!sessionDoc.blobInfo?.blobName) {
    return {
      answer: 'Unable to revert: original data not found. The original file may have been deleted.',
    };
  }

  try {
    // Load original file from blob
    const blobBuffer = await getFileFromBlob(sessionDoc.blobInfo.blobName);

    // Parse the file
    let originalData = await parseFile(blobBuffer, sessionDoc.fileName, {
      sheetName: sessionDoc.selectedSheetName,
    });

    if (!originalData || originalData.length === 0) {
      return {
        answer: 'Unable to revert: original data file is empty or could not be parsed.',
      };
    }

    // WPF4 · Re-apply the wide-format melt that ran at upload so "revert
    // to original" returns the post-melt analytical canonical, not the
    // raw wide buffer. Pre-WPF4 this path silently restored wide rows
    // while the post-melt summary still expected long columns.
    try {
      const { applyWideFormatMeltIfNeeded } = await import(
        '../../wideFormat/applyWideFormatMeltIfNeeded.js'
      );
      const wfApplied = applyWideFormatMeltIfNeeded(
        originalData,
        sessionDoc.dataSummary
      );
      if (wfApplied.remelted) {
        originalData = wfApplied.rows as DataRow[];
        logger.log(
          `[dataOps:revert] re-applied wide-format melt → ${originalData.length} long rows`
        );
      }
    } catch (e) {
      logger.warn('⚠️ dataOps:revert wide-format re-melt failed', e);
    }

    // Convert "-" to 0 for numeric columns (same as upload processing)
    const numericColumns = sessionDoc.dataSummary?.numericColumns || [];
    originalData = convertDashToZeroForNumericColumns(originalData, numericColumns);

    // Save the original data back to session
    const saveResult = await saveModifiedData(
      sessionId,
      originalData,
      'revert',
      'Reverted data to original form',
      sessionDoc
    );

    // Wave-FA5 · Revert clears the active filter too. Otherwise the user
    // restores the canonical dataset but is still operating on the
    // filtered view.
    try {
      const translateModule = await import("../../activeFilter/persistActiveFilter.js");
      await translateModule.clearActiveFilter(sessionDoc);
    } catch (e) {
      logger.warn("⚠️ revert: failed to clear active filter", e);
    }

    // Get preview from saved data
    const previewData = await getPreviewFromSavedData(sessionId, originalData);

    return {
      answer: `✅ Successfully reverted the data to its original form. The table now has ${originalData.length} rows with the original structure.`,
      data: originalData,
      preview: previewData,
      saved: true,
    };
  } catch (error) {
    logger.error('Error reverting data:', error);
    return {
      answer: `Failed to revert data: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again or contact support.`,
    };
  }
}
