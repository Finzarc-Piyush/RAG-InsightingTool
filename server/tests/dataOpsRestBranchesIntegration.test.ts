/**
 * INTEGRATION CHARACTERIZATION · the remaining HEAVY local/REST branches of
 * `executeDataOperation` (ARCH-2 / CQ-2 god-file decomposition, Batch 17):
 *   - preview                (filter/preview display branch — pure, never persists)
 *   - treat_outliers         (delegates to pythonService.treatOutliers, then persists)
 *   - create_column          (local default-value column add, persists + tracks lastCreatedColumn)
 *   - create_derived_column  (delegates to pythonService.createDerivedColumn, persists + tracks lastCreatedColumn)
 *   - rename_column          (local rename, persists + tracks lastCreatedColumn)
 *   - filter                 (active-filter overlay OR legacy save; non-destructive when overlay applies)
 *   - revert                 (short-circuit guards when no session / no blob)
 *
 * Each test pins the return shape + (where it persists) the doc read back through
 * the in-memory Cosmos double, plus the `dataOpsContext.lastCreatedColumn`
 * mutation for the column-creating branches. Written BEFORE the per-branch
 * handler extraction and must stay green through it.
 *
 * Hermeticity mirrors `dataOpsAiBranchesIntegration` + `dataOpsPersistPreviewIntegration`:
 *   - Python service HTTP stubbed at `__setFetchFnForTesting` (URL-path routed).
 *   - In-memory Cosmos double via `__setContainerForTesting`.
 *   - Blob writer stubbed via `__setProcessedDataBlobWriterForTesting`.
 * No network, no Python service, no real Azure → no hang.
 *
 * The AI-extraction LLM paths (`extractColumnDetails`, `extractDerivedColumnDetails`)
 * are never reached: every column-creating intent carries an explicit
 * `newColumnName` (+ `defaultValue` / `expression`), so the branch skips the
 * `callLlm` fallback and stays deterministic/offline.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  executeDataOperation,
  type DataOpsIntent,
} from "../lib/dataOps/dataOpsOrchestrator.js";
import { type ChatDocument } from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __setFetchFnForTesting } from "../lib/dataOps/pythonService.js";
import { __setProcessedDataBlobWriterForTesting } from "../lib/blobStorage.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";
import { logger } from "../lib/logger.js";
import {
  makeInMemoryContainer,
  type InMemoryContainerHandle,
  type StoredDoc,
} from "./helpers/inMemoryCosmosContainer.js";
import type { DataRow } from "../lib/dataOps/dataOpsTypes.js";

const SESSION_ID = "dataops-rest-branches-session";
const OWNER = "owner@example.com";

const FIXTURE: DataRow[] = [
  { region: "North", brand: "A", sales: 100, spend: 10 },
  { region: "South", brand: "B", sales: 200, spend: 20 },
  { region: "North", brand: "A", sales: 300, spend: 30 },
];

/** Seed a chat doc whose rawData is the FIXTURE (the pre-op table). */
function buildChatDoc(): StoredDoc {
  const doc: ChatDocument = {
    id: "chat_rest_branches",
    username: OWNER,
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    collaborators: [OWNER],
    dataSummary: {
      rowCount: FIXTURE.length,
      columnCount: 4,
      columns: [
        { name: "region", type: "string" },
        { name: "brand", type: "string" },
        { name: "sales", type: "numeric" },
        { name: "spend", type: "numeric" },
      ],
      numericColumns: ["sales", "spend"],
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
  return { ...(doc as unknown as StoredDoc), fsmrora: OWNER };
}

/** Read the persisted doc back through the double's store. */
function persistedDoc(handle: InMemoryContainerHandle): StoredDoc {
  const stored = handle.dump().find((d) => d.id === "chat_rest_branches");
  assert.ok(stored, "chat doc present in the store");
  return stored!;
}

function persistedRawData(handle: InMemoryContainerHandle): DataRow[] {
  return (persistedDoc(handle).rawData as DataRow[]) ?? [];
}

/** Build a `Response`-shaped object the pythonService parsers accept. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (_k: string) => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Canned `fetch` that routes on URL path; records the last request body per path. */
function makeCannedFetch(responses: Record<string, unknown>) {
  const lastBody: Record<string, any> = {};
  const fetchImpl = (async (url: any, init?: any) => {
    const u = String(url);
    if (init?.body) {
      try {
        const parsed = JSON.parse(init.body as string);
        for (const key of Object.keys(responses)) {
          if (u.includes(key)) lastBody[key] = parsed;
        }
      } catch {
        /* ignore */
      }
    }
    for (const [path, body] of Object.entries(responses)) {
      if (u.includes(path)) return jsonResponse(body);
    }
    throw new Error(`canned fetch: no stub for ${u}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, lastBody };
}

describe("dataOps REST/local branches — integration characterization", () => {
  let handle: InMemoryContainerHandle;

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
    __setProcessedDataBlobWriterForTesting(async (sessionId, _data, version) => ({
      blobUrl: `fake://blob/${sessionId}/v${version}.json`,
      blobName: `${sessionId}/v${version}.json`,
    }));
  });

  afterEach(() => {
    __setContainerForTesting(null);
    __setFetchFnForTesting(null);
    __setProcessedDataBlobWriterForTesting(null);
    __resetSessionWriteChainForTesting();
    restoreLogger();
  });

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------
  it("preview: default first-N preview returns preview only, no persist, no doc mutation", async () => {
    const previewBody = {
      data: FIXTURE.slice(0, 3),
      total_rows: 3,
      returned_rows: 3,
    };
    const { fetchImpl } = makeCannedFetch({ "/preview": previewBody });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "preview",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "show me the data",
    );

    assert.equal(result.saved, undefined, "preview never persists");
    assert.equal(result.data, undefined);
    assert.ok(Array.isArray(result.preview));
    assert.deepEqual(result.preview, FIXTURE.slice(0, 3));
    assert.match(result.answer, /Showing 3 of 3 rows:/);

    assert.deepEqual(persistedRawData(handle), FIXTURE, "no doc mutation");
  });

  it("preview: filterConditions with zero matches short-circuits (no preview, no persist)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "preview",
      filterConditions: [{ column: "region", operator: "=", value: "Nowhere" }],
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "");
    assert.match(result.answer, /No rows match the specified conditions/);
    assert.equal(result.preview, undefined);
    assert.equal(result.saved, undefined);
  });

  // -------------------------------------------------------------------------
  // treat_outliers
  // -------------------------------------------------------------------------
  it("treat_outliers: persists treated data + returns canonical shape with preview", async () => {
    const treated: DataRow[] = FIXTURE.map((r) => ({ ...r }));
    const treatBody = {
      data: treated,
      rows_before: 3,
      rows_after: 3,
      outliers_treated: 1,
      treatment_applied: "cap",
      summary: { columns_treated: ["sales"], outliers_by_column: { sales: 1 } },
    };
    const { fetchImpl, lastBody } = makeCannedFetch({ "/treat-outliers": treatBody });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "treat_outliers",
      column: "sales",
      outlierMethod: "iqr",
      treatmentMethod: "cap",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "treat outliers in sales by capping",
    );

    assert.equal(result.saved, true);
    assert.deepEqual(result.data, treated);
    assert.ok(result.preview, "preview present");
    assert.match(result.answer, /Successfully treated outliers/);
    assert.match(result.answer, /\*\*Method:\*\* IQR/);
    assert.match(result.answer, /\*\*Treatment:\*\* cap/);
    assert.match(result.answer, /\*\*Outliers Treated:\*\* 1/);
    assert.match(result.answer, /- sales: 1 outlier\(s\)/);

    assert.equal(lastBody["/treat-outliers"].method, "iqr");
    assert.equal(lastBody["/treat-outliers"].treatment, "cap");

    const persisted = persistedRawData(handle);
    assert.equal(persisted.length, 3);
    assert.deepEqual(result.preview, persisted.slice(0, 50));
  });

  it("treat_outliers: empty data short-circuits before any fetch", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "treat_outliers",
      column: "sales",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, [], SESSION_ID, undefined, "");
    assert.match(result.answer, /No data available to process/);
    assert.equal(result.saved, undefined);
  });

  // -------------------------------------------------------------------------
  // create_column
  // -------------------------------------------------------------------------
  it("create_column: persists new column, tracks lastCreatedColumn, returns canonical shape", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "create_column",
      newColumnName: "status",
      defaultValue: "active",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "create column status with value active",
    );

    // Return shape is the branch contract: modified data carries the new column.
    assert.equal(result.saved, true);
    assert.ok(Array.isArray(result.data));
    assert.equal(result.data!.length, 3);
    for (const row of result.data!) assert.equal(row.status, "active");
    assert.match(result.answer, /Successfully created column "status" with value "active"/);

    // The branch's `dataOpsContext.lastCreatedColumn` mutation persists to the doc
    // (the interleaved save→context-update ordering this handler must preserve).
    const ctx = (persistedDoc(handle).dataOpsContext ?? {}) as { lastCreatedColumn?: string };
    assert.equal(ctx.lastCreatedColumn, "status");
  });

  it("create_column: missing column name short-circuits (no persist)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    // No newColumnName and an empty message → AI extraction returns nothing →
    // falls through to the "please specify a name" guidance without persisting.
    const intent: DataOpsIntent = {
      operation: "create_column",
      defaultValue: "x",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "");
    assert.match(result.answer, /Please specify a name for the new column/);
    assert.equal(result.saved, undefined);
  });

  // -------------------------------------------------------------------------
  // create_derived_column
  // -------------------------------------------------------------------------
  it("create_derived_column: persists derived column, tracks lastCreatedColumn", async () => {
    const derived: DataRow[] = FIXTURE.map((r) => ({
      ...r,
      total: (r.sales as number) + (r.spend as number),
    }));
    const { fetchImpl, lastBody } = makeCannedFetch({
      "/create-derived-column": { data: derived, errors: [] },
    });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "create_derived_column",
      newColumnName: "total",
      expression: "[sales] + [spend]",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "create column total = sales + spend",
    );

    // Return shape is the branch contract: the python-derived table flows out.
    assert.equal(result.saved, true);
    assert.deepEqual(result.data, derived);
    assert.match(result.answer, /Successfully created column "total" with expression: \[sales\] \+ \[spend\]/);

    assert.equal(lastBody["/create-derived-column"].new_column_name, "total");
    assert.equal(lastBody["/create-derived-column"].expression, "[sales] + [spend]");

    // The interleaved `dataOpsContext.lastCreatedColumn` mutation persists.
    const ctx = (persistedDoc(handle).dataOpsContext ?? {}) as { lastCreatedColumn?: string };
    assert.equal(ctx.lastCreatedColumn, "total");
  });

  it("create_derived_column: python errors short-circuit (no persist)", async () => {
    const { fetchImpl } = makeCannedFetch({
      "/create-derived-column": { data: [], errors: ["Column [missing] not found"] },
    });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "create_derived_column",
      newColumnName: "total",
      expression: "[missing] + [spend]",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "create column total = missing + spend",
    );
    assert.match(result.answer, /Error creating column: Column \[missing\] not found/);
    assert.equal(result.saved, undefined);
    // No mutation: original cols intact.
    assert.equal("total" in (persistedRawData(handle)[0] as DataRow), false);
  });

  // -------------------------------------------------------------------------
  // rename_column
  // -------------------------------------------------------------------------
  it("rename_column: persists rename, tracks lastCreatedColumn=new name", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "rename_column",
      oldColumnName: "sales",
      newColumnName: "revenue",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "rename column sales to revenue",
    );

    // Return shape is the branch contract: old name dropped, new name present.
    assert.equal(result.saved, true);
    assert.ok(Array.isArray(result.data));
    for (const row of result.data!) {
      assert.equal("sales" in row, false, "old name dropped");
      assert.ok("revenue" in row, "new name present");
    }
    assert.match(result.answer, /Successfully renamed column "sales" to "revenue"/);

    // The interleaved `dataOpsContext.lastCreatedColumn` mutation → new name persists.
    const ctx = (persistedDoc(handle).dataOpsContext ?? {}) as { lastCreatedColumn?: string };
    assert.equal(ctx.lastCreatedColumn, "revenue");
  });

  it("rename_column: missing new name short-circuits (no persist)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "rename_column",
      oldColumnName: "sales",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "rename column sales",
      [],
    );
    assert.match(result.answer, /Please specify the new name for column "sales"/);
    assert.equal(result.saved, undefined);
    // No mutation.
    assert.ok("sales" in (persistedRawData(handle)[0] as DataRow));
  });

  // -------------------------------------------------------------------------
  // filter
  // -------------------------------------------------------------------------
  it("filter: equality condition applies the active-filter overlay, saved:false, no row destruction", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "filter",
      filterConditions: [{ column: "region", operator: "=", value: "North" }],
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "filter data where region is North",
    );

    // `=` translates cleanly to the active-filter overlay → non-destructive (saved:false).
    assert.equal(result.saved, false);
    assert.ok(Array.isArray(result.data));
    assert.equal(result.data!.length, 2, "2 North rows after filter");
    for (const row of result.data!) assert.equal(row.region, "North");
    assert.match(result.answer, /I've filtered the dataset based on your conditions/);
    assert.match(result.answer, /The filter is active for this analysis/);

    // Canonical dataset preserved (overlay does not mutate rawData).
    assert.deepEqual(persistedRawData(handle), FIXTURE);
  });

  it("filter: no conditions short-circuits with guidance (no persist)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "filter",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "");
    assert.match(result.answer, /No filter conditions specified/);
    assert.equal(result.saved, undefined);
  });

  // -------------------------------------------------------------------------
  // revert
  // -------------------------------------------------------------------------
  it("revert: no session doc short-circuits with guidance", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "revert",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "revert to original");
    assert.match(result.answer, /Unable to revert: session not found/);
    assert.equal(result.saved, undefined);
  });

  it("revert: session doc without blobInfo short-circuits with guidance", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const doc = buildChatDoc() as unknown as ChatDocument;
    // No blobInfo on the seeded doc → original data not found guard.
    const intent: DataOpsIntent = {
      operation: "revert",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, doc, "revert to original");
    assert.match(result.answer, /Unable to revert: original data not found/);
    assert.equal(result.saved, undefined);
  });
});
