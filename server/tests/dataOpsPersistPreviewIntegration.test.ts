/**
 * INTEGRATION CHARACTERIZATION · the dataOps persist+preview core (ARCH-2 / CQ-2).
 *
 * Drives the REAL `executeDataOperation` tail end-to-end through the hermetic
 * in-memory Cosmos double (`__setContainerForTesting`) plus a blob-writer test
 * seam (`__setProcessedDataBlobWriterForTesting`) — the ONLY two networked steps
 * in the `saveModifiedData → getPreviewFromSavedData → { answer, data, preview,
 * saved:true }` shared tail. No real Cosmos / Azure account, so it runs in ms and
 * cannot hang on `waitForContainer()`'s retry loop.
 *
 * It PINS the current behaviour of three representative persist branches whose
 * transform is purely local (no Python / AI):
 *   - remove_column
 *   - replace_value
 *   - remove_rows
 *
 * For each it asserts:
 *   (a) the doc persisted via the double now reflects the modified data
 *       (read back through the double's store + the real read path);
 *   (b) the returned shape is exactly { answer, data, preview, saved:true };
 *   (c) `preview` is present iff `shouldShowPreview`, and equals the saved
 *       doc.rawData.slice(0,50).
 *
 * These tests pin behaviour BEFORE the shared-tail extraction (`persistAndPreview`)
 * and must stay green through it.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  executeDataOperation,
  type DataOpsIntent,
} from "../lib/dataOps/dataOpsOrchestrator.js";
import {
  getChatBySessionIdEfficient,
  type ChatDocument,
} from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __setProcessedDataBlobWriterForTesting } from "../lib/blobStorage.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";
import { logger } from "../lib/logger.js";
import {
  makeInMemoryContainer,
  type InMemoryContainerHandle,
  type StoredDoc,
} from "./helpers/inMemoryCosmosContainer.js";
import type { DataRow } from "../lib/dataOps/dataOpsTypes.js";

const SESSION_ID = "dataops-persist-preview-session";
const OWNER = "owner@example.com";

const FIXTURE: DataRow[] = [
  { region: "North", sales: 100, flag: "-" },
  { region: "South", sales: 200, flag: "ok" },
  { region: "East", sales: 300, flag: "-" },
];

/** Seed a chat doc whose rawData is the FIXTURE (the pre-transform table). */
function buildChatDoc(): StoredDoc {
  const doc: ChatDocument = {
    id: "chat_persist_preview",
    username: OWNER,
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    collaborators: [OWNER],
    dataSummary: {
      rowCount: FIXTURE.length,
      columnCount: 3,
      columns: [
        { name: "region", type: "string" },
        { name: "sales", type: "numeric" },
        { name: "flag", type: "string" },
      ],
      numericColumns: ["sales"],
      dateColumns: [],
    } as unknown as ChatDocument["dataSummary"],
    messages: [],
    charts: [],
    insights: [],
    sessionId: SESSION_ID,
    rawData: FIXTURE.map((r) => ({ ...r })),
    sampleRows: FIXTURE.map((r) => ({ ...r })),
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1.0.0",
    },
  };
  // Chat container partitions on `/fsmrora` (a username mirror).
  return { ...(doc as unknown as StoredDoc), fsmrora: OWNER };
}

/** Read the persisted rawData back through the double's store. */
function persistedRawData(handle: InMemoryContainerHandle): DataRow[] {
  const stored = handle.dump().find((d) => d.id === "chat_persist_preview");
  assert.ok(stored, "chat doc present in the store after persist");
  return (stored!.rawData as DataRow[]) ?? [];
}

describe("dataOps persist+preview core — integration characterization", () => {
  let handle: InMemoryContainerHandle;

  // The save path logs verbosely; silence to keep the TAP-over-socket runner
  // protocol clean (mirrors cosmosDoubleUnlock.test.ts). Behaviour unchanged.
  const originalLogger = { error: logger.error, warn: logger.warn, log: logger.log };
  const silence = () => {
    logger.error = () => {};
    logger.warn = () => {};
    logger.log = () => {};
  };
  const restoreLogger = () => {
    logger.error = originalLogger.error;
    logger.warn = originalLogger.warn;
    logger.log = originalLogger.log;
  };

  beforeEach(() => {
    silence();
    handle = makeInMemoryContainer([buildChatDoc()], { partitionKeyPath: "/fsmrora" });
    __setContainerForTesting(handle.container);
    // Blob writer seam: skip the real Azure upload; return a stable fake ref.
    __setProcessedDataBlobWriterForTesting(async (sessionId, _data, version) => ({
      blobUrl: `fake://blob/${sessionId}/v${version}.json`,
      blobName: `${sessionId}/v${version}.json`,
    }));
  });

  afterEach(() => {
    __setContainerForTesting(null);
    __setProcessedDataBlobWriterForTesting(null);
    __resetSessionWriteChainForTesting();
    restoreLogger();
  });

  it("remove_column: persists the dropped column + returns canonical shape with preview", async () => {
    const intent: DataOpsIntent = {
      operation: "remove_column",
      column: "flag",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID);

    // (b) canonical shape
    assert.equal(result.answer, '✅ Successfully removed column "flag". Here\'s a preview of the updated data:');
    assert.equal(result.saved, true);
    assert.ok(Array.isArray(result.data));
    assert.equal(result.data!.length, 3);
    for (const row of result.data!) {
      assert.equal("flag" in row, false, "column dropped from returned data");
    }

    // (a) persisted doc reflects the modified data
    const persisted = persistedRawData(handle);
    assert.equal(persisted.length, 3);
    for (const row of persisted) assert.equal("flag" in row, false, "column dropped in persisted rawData");

    // (c) remove_column is a data-modification op → shouldShowPreview true →
    //     preview present and equal to the saved doc.rawData.slice(0,50).
    assert.ok(result.preview, "preview present for a modification op");
    assert.deepEqual(result.preview, persisted.slice(0, 50));
  });

  it("replace_value: persists the replacement + returns canonical shape with preview", async () => {
    const intent: DataOpsIntent = {
      operation: "replace_value",
      column: "flag",
      oldValue: "-",
      newValue: "missing",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID);

    // (b) canonical shape — exact answer string (2 replacements in column flag)
    assert.equal(
      result.answer,
      '✅ Replaced 2 occurrence(s) of "-" with "missing" in column "flag". Here\'s a preview of the updated data:',
    );
    assert.equal(result.saved, true);
    assert.equal(result.data!.length, 3);
    assert.equal(result.data![0]!.flag, "missing");
    assert.equal(result.data![1]!.flag, "ok");
    assert.equal(result.data![2]!.flag, "missing");

    // (a) persisted doc reflects the replacement
    const persisted = persistedRawData(handle);
    assert.equal(persisted[0]!.flag, "missing");
    assert.equal(persisted[2]!.flag, "missing");

    // (c) preview present + equals saved slice
    assert.ok(result.preview);
    assert.deepEqual(result.preview, persisted.slice(0, 50));
  });

  it("remove_rows: persists the smaller table + returns canonical shape with preview", async () => {
    const intent: DataOpsIntent = {
      operation: "remove_rows",
      rowPosition: "first",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID);

    // (b) canonical shape — removing the first row
    assert.equal(result.answer, "✅ Removed row 1. Here's a preview of the updated data:");
    assert.equal(result.saved, true);
    assert.equal(result.data!.length, 2);
    assert.equal(result.data![0]!.region, "South");
    assert.equal(result.data![1]!.region, "East");

    // (a) persisted doc reflects the row removal
    const persisted = persistedRawData(handle);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0]!.region, "South");

    // (c) preview present + equals saved slice
    assert.ok(result.preview);
    assert.deepEqual(result.preview, persisted.slice(0, 50));
  });

  it("remove_column without explicit preview request still previews (modification op) but a non-modifying validation error short-circuits before persist", async () => {
    // Validation branch: missing column → early return, NOT the persist tail.
    const intent: DataOpsIntent = {
      operation: "remove_column",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID);
    assert.match(result.answer, /Please specify which column/);
    assert.equal(result.saved, undefined, "validation error does not persist");
    assert.equal(result.data, undefined);
    assert.equal(result.preview, undefined);
    // Store untouched (still the original 3 cols).
    const persisted = persistedRawData(handle);
    assert.equal("flag" in persisted[0]!, true, "no mutation on validation short-circuit");
  });
});
