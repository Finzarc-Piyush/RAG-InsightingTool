import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Container } from "@azure/cosmos";
import type { Request, Response } from "express";

import { uploadQueue, deriveStatusFromEnrichment } from "../utils/uploadQueue.js";
import { getUploadStatus } from "../controllers/uploadController.js";
import { __setContainerForTesting } from "../models/database.config.js";
import type { ChatDocument } from "../models/chat.model.js";

/**
 * DATA-2 · instance-INDEPENDENT upload status polling.
 *
 * The in-memory job Map is instance-pinned: on serverless a status poll that
 * lands on a NON-owning instance (or after a cold start) sees an empty Map.
 * Every job persists `enrichmentStatus` onto the durable Cosmos chat doc, so
 * the status endpoint must fall back to the doc when the Map misses.
 *
 * These tests prove the cross-instance behaviour with the Map FORCED EMPTY
 * (getJob → null), driving the controller against a FAKE Cosmos `Container`
 * injected via `__setContainerForTesting`. No real Cosmos, no network.
 */

function makeRes(): Response & { statusCode: number; body: any } {
  const res = {
    statusCode: 200 as number,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

const OWNER = "owner@example.com";

// DATA-2 · `getChatBySessionIdEfficient` consults a 5 s in-memory doc cache
// keyed by sessionId; each test uses a UNIQUE sessionId so a prior test's
// cached doc can never satisfy a later read against a freshly-injected fake.
let sessionSeq = 0;
const nextSessionId = () => `session_instance_independent_${++sessionSeq}`;

function buildDoc(sessionId: string, overrides: Partial<ChatDocument> = {}): ChatDocument {
  return {
    id: "chat_di_test",
    username: OWNER,
    fileName: "f.csv",
    uploadedAt: 1,
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_500_000,
    collaborators: [OWNER],
    dataSummary: {
      rowCount: 42,
      columnCount: 3,
      columns: [
        { name: "region", type: "string" },
        { name: "month", type: "date" },
        { name: "sales", type: "number" },
      ],
      numericColumns: ["sales"],
      dateColumns: ["month"],
    } as ChatDocument["dataSummary"],
    messages: [],
    charts: [],
    insights: [],
    sessionId,
    rawData: [],
    sampleRows: [{ region: "North", month: "2026-01", sales: 100 }],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1.0.0",
    },
    ...overrides,
  };
}

/** Minimal in-memory fake of the chat `Container`: full-doc query returns the stored doc. */
function makeFakeContainer(stored: ChatDocument | null) {
  const items = {
    query() {
      return {
        async fetchAll() {
          return { resources: stored ? [stored] : [] };
        },
      };
    },
    async upsert(doc: ChatDocument) {
      return { resource: doc };
    },
  };
  return { items } as unknown as Container;
}

/** Force the in-memory Map to miss (cross-instance / cold start). */
async function withEmptyMap(run: () => Promise<void>) {
  const original = uploadQueue.getJob;
  (uploadQueue as unknown as { getJob: unknown }).getJob = () => null;
  try {
    await run();
  } finally {
    (uploadQueue as unknown as { getJob: unknown }).getJob = original;
  }
}

afterEach(() => {
  __setContainerForTesting(null);
});

// --- pure mapper -----------------------------------------------------------

test("DATA-2 · deriveStatusFromEnrichment maps enrichmentStatus → job status", () => {
  const base = { jobId: "job_x", sessionId: "session_mapper", username: OWNER };
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "complete" }).status,
    "completed",
  );
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "complete" }).understandingReady,
    true,
  );
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "failed" }).status,
    "failed",
  );
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "in_progress" }).status,
    "analyzing",
  );
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "pending" }).status,
    "pending",
  );
  // Always flagged as doc-derived so the endpoint/log can tell source apart.
  assert.equal(
    deriveStatusFromEnrichment({ ...base, enrichmentStatus: "complete" }).fromDoc,
    true,
  );
});

// --- controller: cross-instance resolution from the doc --------------------

test("DATA-2 · Map empty + doc enrichmentStatus=complete → status 'completed' (instance-independent)", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: "complete" })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_not_in_this_instance_map" },
      query: { sessionId: sid },
      headers: {},
      auth: { email: OWNER },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 200, "doc-backed poll must succeed cross-instance");
    assert.equal(res.body.status, "completed", "doc enrichmentStatus=complete → completed");
    assert.equal(res.body.progress, 100);
    assert.equal(res.body.phase, "completed");
    assert.equal(res.body.understandingReady, true);
    assert.equal(res.body.enrichmentStatus, "complete");
    assert.equal(res.body.previewReady, true);
    assert.equal(res.body.sessionId, sid);
  });
});

test("DATA-2 · Map empty + doc enrichmentStatus=in_progress → status 'analyzing'", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: "in_progress" })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_cold" },
      query: { sessionId: sid },
      headers: {},
      auth: { email: OWNER },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "analyzing");
    assert.equal(res.body.phase, "enriching");
  });
});

test("DATA-2 · Map empty + doc enrichmentStatus=failed → status 'failed'", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: "failed" })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_cold" },
      query: { sessionId: sid },
      headers: {},
      auth: { email: OWNER },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "failed");
    assert.equal(res.body.phase, "failed");
  });
});

test("DATA-2 · cross-instance doc fallback still enforces tenant isolation (404 for other tenant)", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: "complete" })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_cold" },
      query: { sessionId: sid },
      headers: {},
      auth: { email: "attacker@example.com" },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 404, "doc owner != requester → existence-hiding 404");
    assert.deepEqual(res.body, { error: "Job not found" });
  });
});

test("DATA-2 · Map empty + no sessionId hint → 404 (cannot map jobId → doc)", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: "complete" })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_cold" },
      query: {},
      headers: {},
      auth: { email: OWNER },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 404);
  });
});

test("DATA-2 · Map empty + doc has no enrichmentStatus → 404 (no durable status)", async () => {
  const sid = nextSessionId();
  __setContainerForTesting(makeFakeContainer(buildDoc(sid, { enrichmentStatus: undefined })));
  await withEmptyMap(async () => {
    const req = {
      params: { jobId: "job_cold" },
      query: { sessionId: sid },
      headers: {},
      auth: { email: OWNER },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 404);
  });
});
