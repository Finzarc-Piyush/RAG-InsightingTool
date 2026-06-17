/**
 * `create_column` data-op handler — extracted VERBATIM from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Adds a new column with a static default value (resolved from intent or — only
 * when missing — an AI extraction), persists via `saveModifiedData`, then
 * mutates `sessionDoc.dataOpsContext.lastCreatedColumn` and writes it via a
 * SECOND save (`updateChatDocument`). The interleaving — persist data FIRST,
 * THEN update the context, THEN (only when `shouldShowPreview`) read back a
 * preview — is preserved exactly. A data-modification op:
 * returns `{ answer, data, preview, saved: true }`.
 *
 * The private helper `extractColumnDetails` (used ONLY by this branch) is moved
 * here UNCHANGED alongside the branch body. The only change vs. the orchestrator
 * is collapsing the captured locals into a single typed args object (CQ-2).
 */
import { saveModifiedData } from "../dataPersistence.js";
import {
  getChatBySessionIdEfficient,
  updateChatDocument,
} from "../../../models/chat.model.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import { callLlm } from "../../agents/runtime/callLlm.js";
import { LLM_PURPOSE } from "../../agents/runtime/llmCallPurpose.js";
import { logger } from "../../logger.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent, DataOpsContext } from "../dataOpsOrchestrator.js";

export interface CreateColumnArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionId: string;
  sessionDoc?: ChatDocument;
  originalMessage?: string;
  shouldShowPreview: boolean;
}

export async function handleCreateColumn({
  intent,
  data,
  sessionId,
  sessionDoc,
  originalMessage,
  shouldShowPreview,
}: CreateColumnArgs): Promise<DataOpResult> {
  // Extract column name and default value if not already provided
  let newColumnName = intent.newColumnName;
  let defaultValue = intent.defaultValue;

  // If not provided, try to extract from message using AI
  if (!newColumnName || defaultValue === undefined) {
    const messageText = originalMessage || sessionDoc?.messages?.slice().reverse().find(m => m.role === 'user')?.content || '';
    const extraction = await extractColumnDetails(messageText);
    if (extraction) {
      newColumnName = newColumnName || extraction.columnName;
      defaultValue = defaultValue !== undefined ? defaultValue : extraction.defaultValue;
    }
  }

  if (!newColumnName) {
    return {
      answer: 'Please specify a name for the new column. For example: "Create column status with value active"'
    };
  }

  // Create the column with default value
  // Round numeric default values to 2 decimal places
  let processedDefaultValue = defaultValue;
  if (defaultValue !== undefined && defaultValue !== null) {
    if (typeof defaultValue === 'number') {
      processedDefaultValue = Math.round(defaultValue * 100) / 100; // Round to 2 decimal places
    } else if (typeof defaultValue === 'string') {
      // Try to parse as number and round if successful
      const numValue = parseFloat(defaultValue);
      if (!isNaN(numValue) && isFinite(numValue)) {
        processedDefaultValue = Math.round(numValue * 100) / 100;
      }
    }
  }

  const modifiedData = data.map(row => ({
    ...row,
    [newColumnName!]: processedDefaultValue !== undefined ? processedDefaultValue : null
  }));

  // Save modified data first
  const saveResult = await saveModifiedData(
    sessionId,
    modifiedData,
    'create_column',
    `Created column "${newColumnName}" with default value: ${defaultValue !== undefined ? String(defaultValue) : 'null'}`,
    sessionDoc
  );

  // Update context to track last created column
  if (sessionDoc) {
    const context: DataOpsContext = {
      ...(sessionDoc.dataOpsContext as DataOpsContext || {}),
      lastCreatedColumn: newColumnName,
      timestamp: Date.now()
    };
    sessionDoc.dataOpsContext = context as any;
    await updateChatDocument(sessionDoc);
  }

  // Only show preview if user explicitly requested it
  let previewData: DataRow[] | undefined;
  let answerText = `✅ Successfully created column "${newColumnName}"${defaultValue !== undefined ? ` with value "${defaultValue}"` : ''}.`;

  if (shouldShowPreview) {
    const updatedDoc = await getChatBySessionIdEfficient(sessionId);
    previewData = updatedDoc?.rawData ? updatedDoc.rawData.slice(0, 50) : modifiedData.slice(0, 50);
    answerText += ` Here's a preview of the updated data:`;
  }

  return {
    answer: answerText,
    data: modifiedData,
    preview: previewData,
    saved: true
  };
}

// ---------------------------------------------------------------------------
// Private helper — moved VERBATIM from `dataOpsOrchestrator.ts`; used ONLY by
// the create_column branch above.
// ---------------------------------------------------------------------------

async function extractColumnDetails(
  message: string
): Promise<{ columnName: string; defaultValue?: any } | null> {
  try {
    const prompt = `Extract the column name and default value from the user's query for creating a new column with a static value.

User query: "${message}"

Extract:
1. columnName: The name of the new column to create
2. defaultValue: The value to put in the column (can be string, number, boolean, or null)

Examples:
- "create a new column status and put the value active in it" → columnName: "status", defaultValue: "active"
- "add column Notes with value empty" → columnName: "Notes", defaultValue: ""
- "create column Price with default 100" → columnName: "Price", defaultValue: 100
- "add column Active with value true" → columnName: "Active", defaultValue: true
- "create column Comments" → columnName: "Comments", defaultValue: null

Return JSON:
{
  "columnName": "ColumnName",
  "defaultValue": "value" | number | boolean | null
}`;

    const response = await callLlm(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You extract column names and default values from natural language. Return only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 200,
      },
      { purpose: LLM_PURPOSE.DATAOPS_DEFAULTS }
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.columnName) {
      return {
        columnName: parsed.columnName.trim(),
        defaultValue: parsed.defaultValue !== undefined ? parsed.defaultValue : null,
      };
    }

    return null;
  } catch (error) {
    logger.error('Error extracting column details:', error);
    return null;
  }
}
