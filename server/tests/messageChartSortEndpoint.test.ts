import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Container } from "@azure/cosmos";
import type { Request, Response } from "express";

import { updateMessageChartSortEndpoint } from "../controllers/sessionController.js";
import { type ChatDocument } from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";

/**
 * Wave S5 · drives the REAL chart-sort PATCH controller against a fake Cosmos
 * container (no network). Proves the sort lands on message.charts[i].sort via
 * the mutateChatDocument seam, and that bad input is rejected.
 */

const USER = "tester@example.com";

function buildDoc(sessionId: string, charts: unknown[]): ChatDocument {
  return {
    id: `chat_${sessionId}`,
    username: USER,
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    _etag: "etag-1",
    collaborators: [USER],
    dataSummary: {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    } as ChatDocument["dataSummary"],
    messages: [
      { role: "assistant", content: "", timestamp: 1000, charts } as unknown,
    ] as ChatDocument["messages"],
    charts: [],
    insights: [],
    sessionId,
    rawData: [],
    sampleRows: [],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1.0.0",
    },
  };
}

function makeFakeContainer(stored: ChatDocument | null) {
  const state = { stored };
  const items = {
    query() {
      return {
        async fetchAll() {
          return { resources: state.stored ? [state.stored] : [] };
        },
      };
    },
    async upsert(doc: ChatDocument) {
      state.stored = { ...doc, _etag: "etag-2" } as ChatDocument;
      return { resource: state.stored };
    },
  };
  return {
    container: { items } as unknown as Container,
    current: () => state.stored,
  };
}

function makeReq(
  params: Record<string, string>,
  body: unknown,
): Request {
  return {
    params,
    body,
    headers: { "x-user-email": USER },
    auth: { email: USER },
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as typeof res & Response;
}

afterEach(() => {
  __setContainerForTesting(null);
  __resetSessionWriteChainForTesting();
});

describe("updateMessageChartSortEndpoint (Wave S5)", () => {
  it("persists the sort onto message.charts[i].sort", async () => {
    const sessionId = "sort-ep-happy";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Age", y: "Survived" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSortEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { sort: { by: "category", direction: "asc" } },
      ),
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, sort: { by: "category", direction: "asc" } });
    const stored = fake.current()!;
    const chart = (stored.messages[0] as { charts: Array<{ sort?: unknown }> }).charts[0];
    assert.deepEqual(chart.sort, { by: "category", direction: "asc" });
  });

  it("rejects an invalid sort payload with 400", async () => {
    const sessionId = "sort-ep-badbody";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Age", y: "Survived" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSortEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { sort: { by: "nonsense", direction: "asc" } },
      ),
      res,
    );
    assert.equal(res.statusCode, 400);
  });

  it("returns 404 for an out-of-range chartIndex", async () => {
    const sessionId = "sort-ep-badidx";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Age", y: "Survived" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSortEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "5" },
        { sort: { by: "value", direction: "desc" } },
      ),
      res,
    );
    assert.equal(res.statusCode, 404);
  });

  it("reports an ownership denial as 403, not 500", async () => {
    const sessionId = "sort-ep-403";
    // A doc the caller (u@x.com) does NOT collaborate on → getChatBySessionIdForUser
    // throws a statusCode-403 error, which the catch must surface as 403.
    const doc = buildDoc(sessionId, [{ type: "bar", title: "t", x: "Age", y: "Survived" }]);
    doc.username = "someone-else@x.com";
    doc.collaborators = ["someone-else@x.com"];
    const fake = makeFakeContainer(doc);
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSortEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { sort: { by: "value", direction: "desc" } },
      ),
      res,
    );
    assert.equal(res.statusCode, 403);
  });
});
