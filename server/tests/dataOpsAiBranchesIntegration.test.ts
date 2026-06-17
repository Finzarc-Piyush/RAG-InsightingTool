/**
 * INTEGRATION CHARACTERIZATION · the THREE "AI"/Python data-op branches of
 * `executeDataOperation` (ARCH-2 / CQ-2 god-file decomposition):
 *   - aggregate   (delegates to pythonService.aggregateData)
 *   - pivot       (delegates to pythonService.createPivotTable)
 *   - train_model (delegates to pythonService.trainMLModel)
 *
 * Each branch computes a result via the Python service, then RETURNS its own
 * shape WITHOUT persisting to the session blob and WITHOUT mutating the chat
 * document (all three return `saved: false`). These tests pin that behaviour
 * BEFORE the per-operation handler extraction and must stay green through it.
 *
 * Hermeticity: the Python service HTTP is stubbed at the lowest clean seam —
 * `__setFetchFnForTesting` in `lib/dataOps/pythonService.ts` (mirrors
 * `__setProcessedDataBlobWriterForTesting` / `__setContainerForTesting`). A
 * canned `fetch` routes on URL path and returns the exact response shape each
 * pythonService fn parses, so there is NO network, NO Python service, NO hang.
 * The in-memory Cosmos double (`__setContainerForTesting`) is wired so we can
 * ALSO assert that none of these branches mutate the persisted doc.
 *
 * The train_model branch is driven with an explicit `targetVariable` + `features`
 * so the AI parameter-extraction LLM path (`extractMLModelDetails`) is never
 * reached — keeping the test deterministic and offline.
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
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";
import { logger } from "../lib/logger.js";
import {
  makeInMemoryContainer,
  type InMemoryContainerHandle,
  type StoredDoc,
} from "./helpers/inMemoryCosmosContainer.js";
import type { DataRow } from "../lib/dataOps/dataOpsTypes.js";

const SESSION_ID = "dataops-ai-branches-session";
const OWNER = "owner@example.com";

const FIXTURE: DataRow[] = [
  { region: "North", brand: "A", sales: 100, spend: 10 },
  { region: "South", brand: "B", sales: 200, spend: 20 },
  { region: "North", brand: "A", sales: 300, spend: 30 },
];

/** Seed a chat doc whose rawData is the FIXTURE (the pre-op table). */
function buildChatDoc(): StoredDoc {
  const doc: ChatDocument = {
    id: "chat_ai_branches",
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

/** Read the persisted rawData back through the double's store. */
function persistedRawData(handle: InMemoryContainerHandle): DataRow[] {
  const stored = handle.dump().find((d) => d.id === "chat_ai_branches");
  assert.ok(stored, "chat doc present in the store");
  return (stored!.rawData as DataRow[]) ?? [];
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

/**
 * Canned `fetch` that routes on URL path. Each handler in `responses` is the
 * raw JSON the corresponding pythonService fn expects. Records the last request
 * body per path so a test can assert what the branch sent to Python.
 */
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

describe("dataOps AI/Python branches — integration characterization", () => {
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
  });

  afterEach(() => {
    __setContainerForTesting(null);
    __setFetchFnForTesting(null);
    __resetSessionWriteChainForTesting();
    restoreLogger();
  });

  it("aggregate: returns aggregated data + row-level preview, saved:false, no doc mutation", async () => {
    const aggregated: DataRow[] = [
      { region: "North", "sales(Sum)": 400, "spend(Sum)": 40 },
      { region: "South", "sales(Sum)": 200, "spend(Sum)": 20 },
    ];
    const { fetchImpl, lastBody } = makeCannedFetch({
      "/aggregate": { data: aggregated, rows_before: 3, rows_after: 2 },
    });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "aggregate",
      groupByColumn: "region",
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "aggregate sales by region",
    );

    // Returned shape: aggregated `data`, row-level `preview`, saved:false.
    assert.equal(result.saved, false);
    assert.deepEqual(result.data, aggregated);
    assert.ok(Array.isArray(result.preview));
    assert.equal(result.preview!.length, 3, "row-level preview is the input slice");
    assert.deepEqual(result.preview, FIXTURE.slice(0, 3));

    // Answer string pins the exact phrasing (2 numeric Sum cols, 2 rows from 3).
    assert.match(result.answer, /created a new aggregated table grouped by "region"/);
    assert.match(result.answer, /Aggregated 2 numeric columns/);
    assert.match(result.answer, /result has 2 rows \(down from 3\)/);

    // The branch sent the groupBy to Python.
    assert.equal(lastBody["/aggregate"].group_by_column, "region");

    // No doc mutation: persisted rawData is still the FIXTURE.
    assert.deepEqual(persistedRawData(handle), FIXTURE);
  });

  it("aggregate: missing groupBy short-circuits with a clarification (no fetch)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "aggregate",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "");
    assert.match(result.answer, /Please specify which column to aggregate by/);
    assert.equal(result.data, undefined);
    assert.equal(result.saved, undefined);
  });

  it("pivot: returns pivoted data + row-level preview, saved:false, no doc mutation", async () => {
    const pivoted: DataRow[] = [
      { region: "North", sales_A: 400, spend_A: 40 },
      { region: "South", sales_B: 200, spend_B: 20 },
    ];
    const { fetchImpl, lastBody } = makeCannedFetch({
      "/pivot": { data: pivoted, rows_before: 3, rows_after: 2 },
    });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "pivot",
      pivotIndex: "region",
      pivotValues: ["sales", "spend"],
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "pivot on region showing sales, spend",
    );

    assert.equal(result.saved, false);
    assert.deepEqual(result.data, pivoted);
    assert.ok(Array.isArray(result.preview));
    assert.deepEqual(result.preview, FIXTURE.slice(0, 3));

    assert.match(result.answer, /created a pivot table on "region"/);
    assert.match(result.answer, /result has 2 rows \(down from 3\)/);

    assert.equal(lastBody["/pivot"].index_column, "region");
    assert.deepEqual(lastBody["/pivot"].value_columns, ["sales", "spend"]);

    assert.deepEqual(persistedRawData(handle), FIXTURE);
  });

  it("pivot: missing index column short-circuits with a clarification (no fetch)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "pivot",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "");
    assert.match(result.answer, /Please specify which column to use as the pivot index/);
    assert.equal(result.data, undefined);
    assert.equal(result.saved, undefined);
  });

  it("train_model: returns formatted model report, saved:false, no doc mutation", async () => {
    const trainResponse = {
      model_type: "linear",
      task_type: "regression",
      target_variable: "sales",
      features: ["spend"],
      coefficients: { intercept: 5.5, features: { spend: 9.5 } },
      metrics: {
        train: { r2_score: 0.99 },
        test: { r2_score: 0.95, rmse: 1.25, mae: 1.0 },
        cross_validation: { mean_r2: 0.9 },
      },
      predictions: [1, 2, 3],
      feature_importance: null,
      n_samples: 3,
      n_train: 2,
      n_test: 1,
    };
    const { fetchImpl, lastBody } = makeCannedFetch({
      "/train-model": trainResponse,
    });
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "train_model",
      modelType: "linear",
      targetVariable: "sales",
      features: ["spend"],
      requiresClarification: false,
    };
    const result = await executeDataOperation(
      intent,
      FIXTURE,
      SESSION_ID,
      buildChatDoc() as unknown as ChatDocument,
      "train a linear model with sales as target and spend as feature",
    );

    // ML models don't modify data.
    assert.equal(result.saved, false);
    assert.equal(result.data, undefined);
    assert.equal(result.preview, undefined);

    // Formatted report pins the key lines `extractPreviousModelParams` later reparses.
    assert.match(result.answer, /successfully trained a linear model/);
    assert.match(result.answer, /Target Variable: sales/);
    assert.match(result.answer, /Features: spend/);
    assert.match(result.answer, /Training Samples: 2/);
    assert.match(result.answer, /Test Samples: 1/);
    assert.match(result.answer, /R² Score: 0\.9500/);
    assert.match(result.answer, /Intercept: 5\.5000/);

    // The branch matched columns and sent them to Python.
    assert.equal(lastBody["/train-model"].model_type, "linear");
    assert.equal(lastBody["/train-model"].target_variable, "sales");
    assert.deepEqual(lastBody["/train-model"].features, ["spend"]);

    assert.deepEqual(persistedRawData(handle), FIXTURE);
  });

  it("train_model: missing target variable short-circuits with guidance (no fetch)", async () => {
    const { fetchImpl } = makeCannedFetch({});
    __setFetchFnForTesting(fetchImpl);

    const intent: DataOpsIntent = {
      operation: "train_model",
      modelType: "linear",
      features: ["spend"],
      requiresClarification: false,
    };
    // No targetVariable, no previous-model context, empty message → no LLM call,
    // falls through to the "please specify target" guidance.
    const result = await executeDataOperation(intent, FIXTURE, SESSION_ID, undefined, "", []);
    assert.match(result.answer, /Please specify the target variable/);
    assert.equal(result.saved, undefined);
  });
});
