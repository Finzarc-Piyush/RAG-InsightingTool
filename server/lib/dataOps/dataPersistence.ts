/**
 * Data Persistence Module
 *
 * Data flow (keep in mind):
 * - Initial data (Snowflake or CSV/Excel upload) is always stored in blob; Cosmos holds blobInfo reference.
 * - When user filters or transforms data, the result is stored in blob again; Cosmos holds currentDataBlob reference.
 * - Revert = point "current" back to original: clear currentDataBlob so loadLatestData uses blobInfo (no duplicate blob).
 */
import { updateProcessedDataBlob, getFileFromBlob } from '../blobStorage.js';
import { getChatBySessionIdEfficient, updateChatDocument, ChatDocument } from '../../models/chat.model.js';
import { createDataSummary, parseFile, convertDashToZeroForNumericColumns } from '../fileParser.js';
import { generateColumnStatistics } from '../../models/chat.model.js';

export interface SaveDataResult {
  version: number;
  rowsBefore: number;
  rowsAfter: number;
  blobUrl: string;
  blobName: string;
  saved?: boolean;
}

export interface RevertToOriginalResult {
  reverted: true;
  rowCount: number;
  preview: Record<string, any>[];
}

/**
 * Revert session to original data without creating a new blob.
 * Loads original from blobInfo, updates Cosmos only (clear currentDataBlob, refresh summary/sampleRows).
 * Next loadLatestData will use blobInfo (original blob).
 */
export async function revertToOriginalData(
  sessionId: string,
  sessionDoc: ChatDocument
): Promise<RevertToOriginalResult> {
  if (!sessionDoc.blobInfo?.blobName) {
    throw new Error('Original data not found. The original file may have been deleted.');
  }

  const blobBuffer = await getFileFromBlob(sessionDoc.blobInfo.blobName);
  let originalData: Record<string, any>[];

  try {
    const parsed = JSON.parse(blobBuffer.toString('utf-8'));
    if (Array.isArray(parsed) && parsed.length > 0) {
      originalData = parsed;
    } else {
      originalData = await parseFile(blobBuffer, sessionDoc.fileName || 'data.json');
    }
  } catch {
    originalData = await parseFile(blobBuffer, sessionDoc.fileName || 'data.csv');
  }

  if (!originalData || originalData.length === 0) {
    throw new Error('Original data file is empty or could not be parsed.');
  }

  const numericColumns = sessionDoc.dataSummary?.numericColumns || [];
  originalData = convertDashToZeroForNumericColumns(originalData, numericColumns);

  const doc = { ...sessionDoc };
  doc.currentDataBlob = undefined;
  doc.rawData = [];
  doc.dataSummary = createDataSummary(originalData);
  doc.dataSummaryStatistics = undefined;
  doc.columnStatistics = generateColumnStatistics(originalData, doc.dataSummary.numericColumns);

  const SAMPLE_ROWS_CAP = 50;
  const serializeRow = (row: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        out[key] = value.toISOString();
      } else if (typeof value === 'string' && value.length > 500) {
        out[key] = value.slice(0, 500) + (value.length > 500 ? '…' : '');
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  doc.sampleRows = originalData.slice(0, SAMPLE_ROWS_CAP).map(serializeRow);

  if (!doc.dataVersions) doc.dataVersions = [];
  doc.dataVersions.push({
    versionId: `revert_${Date.now()}`,
    blobName: sessionDoc.blobInfo.blobName,
    operation: 'revert',
    description: 'Reverted to original data',
    timestamp: Date.now(),
    parameters: { rowCount: originalData.length },
    rowsAfter: originalData.length,
  });
  if (doc.dataVersions.length > 10) {
    doc.dataVersions = doc.dataVersions.slice(-10);
  }
  doc.lastUpdatedAt = Date.now();

  const COSMOS_DOCUMENT_LIMIT_BYTES = 1.9 * 1024 * 1024;
  let docPayload = JSON.stringify(doc);
  if (docPayload.length > COSMOS_DOCUMENT_LIMIT_BYTES) {
    doc.sampleRows = doc.sampleRows.slice(0, 20).map(serializeRow);
    docPayload = JSON.stringify(doc);
    if (docPayload.length > COSMOS_DOCUMENT_LIMIT_BYTES) {
      doc.sampleRows = [];
    }
  }

  await updateChatDocument(doc);
  console.log(`✅ Reverted to original data (${originalData.length} rows). Cosmos updated; no new blob.`);

  const preview = originalData.slice(0, 50).map(serializeRow);
  return {
    reverted: true,
    rowCount: originalData.length,
    preview,
  };
}

/**
 * Save modified data to blob storage and update CosmosDB metadata.
 * Filter/transform results are stored in blob; Cosmos holds currentDataBlob reference.
 */
export async function saveModifiedData(
  sessionId: string,
  modifiedData: Record<string, any>[],
  operation: string,
  description: string,
  sessionDoc?: ChatDocument
): Promise<SaveDataResult> {
  // Get current document
  const doc = sessionDoc ?? await getChatBySessionIdEfficient(sessionId);
  if (!doc) {
    throw new Error('Session not found');
  }

  // Determine new version
  const currentVersion = doc.currentDataBlob?.version || 1;
  const newVersion = currentVersion + 1;

  // Get username from document
  const username = doc.username;

  // Check if this is a large dataset
  const isLargeDataset = modifiedData.length > 50000;
  if (isLargeDataset) {
    console.log(`📊 Large dataset detected (${modifiedData.length} rows). Saving to blob storage with streaming optimization...`);
  }

  // Save new version to blob
  // updateProcessedDataBlob handles large datasets efficiently
  console.log(`💾 Saving aggregated data to blob storage: ${modifiedData.length} rows, version ${newVersion}`);
  const newBlob = await updateProcessedDataBlob(
    sessionId,
    modifiedData,
    newVersion,
    username
  );
  console.log(`✅ Saved to blob storage: ${newBlob.blobName} (${newBlob.blobUrl})`);

  // Calculate metrics
  const rowsBefore = doc.dataSummary?.rowCount || 0;
  const rowsAfter = modifiedData.length;
  const columnsBefore = doc.dataSummary?.columns?.map(c => c.name) || [];
  const columnsAfter = Object.keys(modifiedData[0] || {});
  const affectedColumns = columnsBefore.filter(c => !columnsAfter.includes(c))
    .concat(columnsAfter.filter(c => !columnsBefore.includes(c)));

  // Update CosmosDB metadata
  doc.currentDataBlob = {
    blobUrl: newBlob.blobUrl,
    blobName: newBlob.blobName,
    version: newVersion,
    lastUpdated: Date.now(),
  };

  // CosmosDB document limit is 2MB; keep sample small so doc + messages/charts stay under limit
  const SAMPLE_ROWS_CAP = 50;
  const serializeRow = (row: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        out[key] = value.toISOString();
      } else if (typeof value === 'string' && value.length > 500) {
        out[key] = value.slice(0, 500) + (value.length > 500 ? '…' : '');
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  doc.sampleRows = modifiedData.slice(0, SAMPLE_ROWS_CAP).map(serializeRow);

  // Validate data before creating summary
  if (!modifiedData || modifiedData.length === 0) {
    throw new Error('Cannot save empty dataset. The data operation resulted in no data.');
  }
  
  // Update data summary
  doc.dataSummary = createDataSummary(modifiedData);
  
  // Clear pre-computed data summary statistics since data has changed
  // It will be recomputed on next request or can be recomputed during next upload
  doc.dataSummaryStatistics = undefined;

  // Update column statistics
  doc.columnStatistics = generateColumnStatistics(modifiedData, doc.dataSummary.numericColumns);

  // Never store full rawData in Cosmos when saving from Data Ops: document limit is 2MB
  // and doc already has messages, charts, etc. Data is in blob; loadLatestData uses blob when rawData is empty.
  doc.rawData = [];
  console.log(`📄 Keeping rawData empty in Cosmos (data in blob). Preview from sampleRows (${doc.sampleRows.length} rows).`);

  // Add to version history
  if (!doc.dataVersions) {
    doc.dataVersions = [];
  }
  
  doc.dataVersions.push({
    versionId: `v${newVersion}`,
    blobName: newBlob.blobName,
    operation,
    description,
    timestamp: Date.now(),
    parameters: {
      rowsBefore,
      rowsAfter,
      columnsBefore: columnsBefore.length,
      columnsAfter: columnsAfter.length,
      affectedRows: rowsAfter - rowsBefore,
      affectedColumns: affectedColumns.length > 0 ? affectedColumns : undefined,
    },
    affectedRows: rowsAfter - rowsBefore,
    affectedColumns: affectedColumns.length > 0 ? affectedColumns : undefined,
    rowsBefore,
    rowsAfter,
  });

  // Keep only last 10 versions
  if (doc.dataVersions.length > 10) {
    doc.dataVersions = doc.dataVersions.slice(-10);
  }

  // Update last updated timestamp
  doc.lastUpdatedAt = Date.now();

  // CosmosDB document size limit is 2MB; ensure we don't exceed it
  const COSMOS_DOCUMENT_LIMIT_BYTES = 1.9 * 1024 * 1024; // 1.9MB to leave headroom
  let docPayload = JSON.stringify(doc);
  if (docPayload.length > COSMOS_DOCUMENT_LIMIT_BYTES) {
    console.warn(`⚠️ Document size ${(docPayload.length / 1024 / 1024).toFixed(2)}MB exceeds limit. Reducing sampleRows.`);
    doc.sampleRows = doc.sampleRows.slice(0, 20).map(serializeRow);
    docPayload = JSON.stringify(doc);
    if (docPayload.length > COSMOS_DOCUMENT_LIMIT_BYTES) {
      doc.sampleRows = [];
      console.warn(`⚠️ Document still too large after trimming sampleRows. Saving with empty sampleRows.`);
    }
  }

  // Update document
  await updateChatDocument(doc);
  console.log(`✅ Updated CosmosDB document with blob reference: version ${newVersion}, blob: ${newBlob.blobName}`);

  return {
    version: newVersion,
    rowsBefore,
    rowsAfter,
    blobUrl: newBlob.blobUrl,
    blobName: newBlob.blobName,
    saved: true,
  };
}

