/**
 * Data Persistence Module
 * Handles saving modified data to blob storage and updating CosmosDB
 */
import { updateProcessedDataBlob } from '../blobStorage.js';
import { getChatBySessionIdEfficient, updateChatDocument, ChatDocument } from '../../models/chat.model.js';
import { createDataSummary, canonicalizeDateColumnValues } from '../fileParser.js';
import {
  applyTemporalFacetColumns,
  periodDimensionFromSummary,
} from '../temporalFacetColumns.js';
import { generateColumnStatistics } from '../../models/chat.model.js';
import { withSessionWriteLock } from '../sessionWriteLock.js';
import { logger } from "../logger.js";

export interface SaveDataResult {
  version: number;
  rowsBefore: number;
  rowsAfter: number;
  blobUrl: string;
  blobName: string;
}

// Removed SaveDataOptions - we'll generate preview from rawData instead

/**
 * Save modified data to blob storage and update CosmosDB metadata.
 *
 * Wave A4 · Now serialised with EVERY other Cosmos-facing RMW on the
 * same chat document via `withSessionWriteLock` (Wave A2). Pre-A4 the
 * computed-column persist (`add_computed_columns(persistToSession:true)`)
 * could race against turn-end `persistMergeAssistantSessionContext`,
 * a BAI patch, or an active-filter PUT — last-writer-wins on the upsert
 * meant a turn-end persist following a computed-column persist could
 * silently drop the new column. The lock closes that window.
 *
 * Note about `sessionDoc`: callers pass a previously-fetched chat
 * document, often with their own in-flight mutations (e.g. the orchestrator
 * stamps `dataOpsContext` onto it before calling). The lock guarantees
 * write serialisation, but the doc-mutation pattern (mutate locally then
 * call save) still has a stale-read risk if a concurrent path wrote in
 * between the caller's fetch and the call here. Recorded as a follow-up:
 * future cleanup wave should re-fetch inside the lock and copy any
 * caller-mutated fields onto the fresh doc. For Wave A4 the minimal fix
 * is just the lock; concurrent fields rarely overlap in practice.
 */
export async function saveModifiedData(
  sessionId: string,
  modifiedData: Record<string, any>[],
  operation: string,
  description: string,
  sessionDoc?: ChatDocument
): Promise<SaveDataResult> {
  return withSessionWriteLock(sessionId, () =>
    saveModifiedDataLocked(sessionId, modifiedData, operation, description, sessionDoc)
  );
}

async function saveModifiedDataLocked(
  sessionId: string,
  modifiedData: Record<string, any>[],
  operation: string,
  description: string,
  sessionDoc?: ChatDocument
): Promise<SaveDataResult> {
  // Validate before the expensive blob write.
  if (!modifiedData || modifiedData.length === 0) {
    throw new Error('Cannot save empty dataset. The data operation resulted in no data.');
  }

  // DATA-4: read the doc FRESH inside the lock rather than trusting the
  // caller-supplied `sessionDoc`, which may have been fetched earlier in the
  // turn and gone stale. Carry over ONLY the caller's intended in-flight
  // mutation (`dataOpsContext`) onto the fresh doc, so a concurrent writer's
  // changes to other fields are preserved.
  const callerDataOpsContext = sessionDoc?.dataOpsContext;
  const doc = await getChatBySessionIdEfficient(sessionId, /* forceRefresh */ true);
  if (!doc) {
    throw new Error('Session not found');
  }
  if (callerDataOpsContext !== undefined) {
    doc.dataOpsContext = callerDataOpsContext;
  }

  // Determine new version
  const currentVersion = doc.currentDataBlob?.version || 1;
  const newVersion = currentVersion + 1;

  // Get username from document
  const username = doc.username;

  // Check if this is a large dataset
  const isLargeDataset = modifiedData.length > 50000;
  if (isLargeDataset) {
    logger.log(`📊 Large dataset detected (${modifiedData.length} rows). Saving to blob storage with streaming optimization...`);
  }

  // Save new version to blob
  // updateProcessedDataBlob handles large datasets efficiently
  logger.log(`💾 Saving aggregated data to blob storage: ${modifiedData.length} rows, version ${newVersion}`);
  const newBlob = await updateProcessedDataBlob(
    sessionId,
    modifiedData,
    newVersion,
    username
  );
  logger.log(`✅ Saved to blob storage: ${newBlob.blobName} (${newBlob.blobUrl})`);

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

  // Update sample rows (first 100)
  doc.sampleRows = modifiedData.slice(0, 100).map(row => {
    const serializedRow: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        serializedRow[key] = value.toISOString();
      } else {
        serializedRow[key] = value;
      }
    }
    return serializedRow;
  });

  // Update data summary (canonicalize dates then refresh typing / grains)
  const preSummary = createDataSummary(modifiedData);
  canonicalizeDateColumnValues(modifiedData, preSummary.dateColumns);
  // The fresh heuristic preSummary doesn't carry the melt's wideFormatTransform;
  // source the period dimension from the persisted session summary (self-detect
  // backstops if absent).
  applyTemporalFacetColumns(modifiedData, preSummary.dateColumns, {
    periodDimension: periodDimensionFromSummary(doc.dataSummary),
  });
  doc.dataSummary = createDataSummary(modifiedData);
  
  // Clear pre-computed data summary statistics since data has changed
  // It will be recomputed on next request or can be recomputed during next upload
  doc.dataSummaryStatistics = undefined;

  // Update column statistics
  doc.columnStatistics = generateColumnStatistics(modifiedData, doc.dataSummary.numericColumns);

  // Update rawData in document
  // For large datasets, don't store in CosmosDB (4MB limit)
  // Only store if dataset is small enough
  const estimatedSize = JSON.stringify(modifiedData).length;
  const MAX_DOCUMENT_SIZE = 3 * 1024 * 1024; // 3MB safety margin
  
  if (estimatedSize < MAX_DOCUMENT_SIZE && modifiedData.length < 10000) {
    doc.rawData = modifiedData.map(row => {
      const serializedRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value instanceof Date) {
          serializedRow[key] = value.toISOString();
        } else {
          serializedRow[key] = value;
        }
      }
      return serializedRow;
    });
    logger.log(`✅ Updated rawData in CosmosDB document (${modifiedData.length} rows)`);
  } else {
    // Dataset too large - don't store in CosmosDB, it's already in blob storage
    logger.log(`⚠️ Dataset too large for CosmosDB (${modifiedData.length} rows, ~${(estimatedSize / 1024 / 1024).toFixed(2)}MB). Keeping rawData empty - data is in blob storage.`);
    doc.rawData = []; // Clear rawData - it's stored in blob
  }

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

  // DATA-3: persist with optimistic concurrency (IfMatch _etag) instead of a
  // bare last-writer-wins upsert. We are already inside withSessionWriteLock, so
  // we cannot call mutateChatDocument (non-reentrant — would deadlock); instead
  // we replicate its read-fresh → reapply → IfMatch loop inline, applying ONLY
  // the fields this save owns onto the freshest doc so a concurrent writer
  // (turn-end persist, BAI patch, active-filter PUT on another instance) is not
  // clobbered.
  const patch: Partial<ChatDocument> = {
    currentDataBlob: doc.currentDataBlob,
    sampleRows: doc.sampleRows,
    dataSummary: doc.dataSummary,
    dataSummaryStatistics: doc.dataSummaryStatistics,
    columnStatistics: doc.columnStatistics,
    rawData: doc.rawData,
    dataVersions: doc.dataVersions,
    lastUpdatedAt: doc.lastUpdatedAt,
  };
  if (callerDataOpsContext !== undefined) {
    patch.dataOpsContext = doc.dataOpsContext;
  }
  await persistMetadataPatchWithEtag(sessionId, doc, patch);
  logger.log(`✅ Updated CosmosDB document with blob reference: version ${newVersion}, blob: ${newBlob.blobName}`);

  const { scheduleIndexSessionRag } = await import("../rag/indexSession.js");
  scheduleIndexSessionRag(sessionId);

  // W59 · record `data_op` in the durable Memory journal so resume-after-days
  // shows every transform as a milestone in the analysis timeline.
  void (async () => {
    try {
      const { buildDataOpEntry, scheduleLifecycleMemory } = await import(
        "../agents/runtime/memoryLifecycleBuilders.js"
      );
      scheduleLifecycleMemory(
        buildDataOpEntry({
          sessionId,
          username,
          operation,
          description,
          dataVersion: newVersion,
          rowsBefore,
          rowsAfter,
          blobName: newBlob.blobName,
          createdAt: Date.now(),
          // Use newVersion as the per-version sequence so concurrent ops
          // collide deterministically on the same id (idempotent upsert).
          sequence: newVersion,
        })
      );
    } catch (e) {
      logger.warn("⚠️ analysisMemory data_op hook failed:", e);
    }
  })();

  return {
    version: newVersion,
    rowsBefore,
    rowsAfter,
    blobUrl: newBlob.blobUrl,
    blobName: newBlob.blobName,
  };
}

/** True for a Cosmos 412 Precondition Failed (IfMatch `_etag` mismatch). */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number } | null;
  return e?.code === 412 || e?.statusCode === 412;
}

/**
 * DATA-3 · ETag-safe metadata write for a path that ALREADY holds
 * `withSessionWriteLock` (so it must NOT call `mutateChatDocument` — that is
 * non-reentrant and would deadlock). The first attempt writes the doc we just
 * mutated (its `_etag` came from our fresh in-lock read); on a 412 (another
 * serverless instance moved the doc) we re-read fresh, re-apply ONLY our
 * `patch` fields onto it, and retry — bounded by `maxRetries`. This preserves
 * the concurrent writer's changes to every field outside `patch`.
 */
async function persistMetadataPatchWithEtag(
  sessionId: string,
  firstDoc: ChatDocument,
  patch: Partial<ChatDocument>,
  maxRetries = 3
): Promise<ChatDocument> {
  let target = firstDoc;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await updateChatDocument(target, { ifMatchEtag: target._etag });
    } catch (err) {
      if (isPreconditionFailed(err) && attempt < maxRetries) {
        lastErr = err;
        const fresh = await getChatBySessionIdEfficient(sessionId, /* forceRefresh */ true);
        if (!fresh) throw err;
        Object.assign(fresh, patch);
        target = fresh;
        logger.warn(
          `↻ saveModifiedData: 412 on ${sessionId} (attempt ${attempt}/${maxRetries}); retrying against fresh doc`
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`saveModifiedData: exhausted retries for ${sessionId}`);
}

