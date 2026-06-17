/**
 * `rename_column` data-op handler — extracted VERBATIM from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Renames a column (resolving the target from intent, or — when absent — the
 * last-created column found in chat history via a dynamic `contextResolver`
 * import). Has TWO save sites: the context-resolved early branch AND the main
 * branch, each persisting via `saveModifiedData`, then mutating
 * `sessionDoc.dataOpsContext.lastCreatedColumn` (= the NEW name) and writing it
 * via a SECOND save (`updateChatDocument`). The ordering — persist data FIRST,
 * THEN update the context, THEN (only when `shouldShowPreview`) read back a
 * preview — is preserved exactly in BOTH save sites. A data-modification op:
 * returns `{ answer, data, preview, saved: true }`.
 *
 * The only change vs. the orchestrator is collapsing the captured locals into a
 * single typed args object (CQ-2). Same dynamic `contextResolver.js` import,
 * same saves, same answer strings, same return shape.
 */
import { Message } from "../../../shared/schema.js";
import { saveModifiedData, getPreviewFromSavedData } from "../dataPersistence.js";
import { updateChatDocument } from "../../../models/chat.model.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent, DataOpsContext } from "../dataOpsOrchestrator.js";

export interface RenameColumnArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionId: string;
  sessionDoc?: ChatDocument;
  chatHistory?: Message[];
  shouldShowPreview: boolean;
}

export async function handleRenameColumn({
  intent,
  data,
  sessionId,
  sessionDoc,
  chatHistory,
  shouldShowPreview,
}: RenameColumnArgs): Promise<DataOpResult> {
  // Determine which column to rename
  const columnToRename = intent.oldColumnName || intent.column;
  const newName = intent.newColumnName;

  if (!columnToRename) {
    // Try to find from context
    const { findLastCreatedColumn } = await import('../../agents/contextResolver.js');
    const lastColumn = findLastCreatedColumn(chatHistory || []);
    if (lastColumn) {
      const resolvedColumn = lastColumn;
      if (!newName) {
        return {
          answer: `I found column "${resolvedColumn}" from context. What would you like to rename it to?`
        };
      }

      // Use resolved column
      const modifiedData = data.map(row => {
        const newRow = { ...row };
        if (resolvedColumn in newRow) {
          newRow[newName] = newRow[resolvedColumn];
          delete newRow[resolvedColumn];
        }
        return newRow;
      });

      const saveResult = await saveModifiedData(
        sessionId,
        modifiedData,
        'rename_column',
        `Renamed column "${resolvedColumn}" to "${newName}"`,
        sessionDoc
      );

      // Update context
      if (sessionDoc) {
        const context: DataOpsContext = {
          ...(sessionDoc.dataOpsContext as DataOpsContext || {}),
          lastCreatedColumn: newName, // Update to new name
          timestamp: Date.now()
        };
        sessionDoc.dataOpsContext = context as any;
        await updateChatDocument(sessionDoc);
      }

      let previewData: DataRow[] | undefined;
      let answerText = `✅ Successfully renamed column "${resolvedColumn}" to "${newName}".`;

      if (shouldShowPreview) {
        previewData = await getPreviewFromSavedData(sessionId, modifiedData);
        answerText += ` Here's a preview of the updated data:`;
      }

      return {
        answer: answerText,
        data: modifiedData,
        preview: previewData,
        saved: true
      };
    }

    return {
      answer: 'Please specify which column you want to rename. For example: "Rename column Sales to Revenue" or "Change the above column name to Two"'
    };
  }

  if (!newName) {
    return {
      answer: `Please specify the new name for column "${columnToRename}". For example: "Rename column ${columnToRename} to NewName"`
    };
  }

  // Check if column exists
  if (data.length > 0 && !(columnToRename in data[0]!)) {
    return {
      answer: `Column "${columnToRename}" not found. Available columns: ${Object.keys(data[0] || {}).join(', ')}`
    };
  }

  // Check if new name already exists
  if (data.length > 0 && newName in data[0]! && newName !== columnToRename) {
    return {
      answer: `Cannot rename: Column "${newName}" already exists. Please choose a different name.`
    };
  }

  // Rename the column
  const modifiedData = data.map(row => {
    const newRow = { ...row };
    if (columnToRename in newRow) {
      newRow[newName] = newRow[columnToRename];
      delete newRow[columnToRename];
    }
    return newRow;
  });

  // Save modified data first
  const saveResult = await saveModifiedData(
    sessionId,
    modifiedData,
    'rename_column',
    `Renamed column "${columnToRename}" to "${newName}"`,
    sessionDoc
  );

  // Update context to track renamed column
  if (sessionDoc) {
    const context: DataOpsContext = {
      ...(sessionDoc.dataOpsContext as DataOpsContext || {}),
      lastCreatedColumn: newName, // Update to new name
      timestamp: Date.now()
    };
    sessionDoc.dataOpsContext = context as any;
    await updateChatDocument(sessionDoc);
  }

  // Only show preview if user explicitly requested it
  let previewData: DataRow[] | undefined;
  let answerText = `✅ Successfully renamed column "${columnToRename}" to "${newName}".`;

  if (shouldShowPreview) {
    previewData = await getPreviewFromSavedData(sessionId, modifiedData);
    answerText += ` Here's a preview of the updated data:`;
  }

  return {
    answer: answerText,
    data: modifiedData,
    preview: previewData,
    saved: true
  };
}
