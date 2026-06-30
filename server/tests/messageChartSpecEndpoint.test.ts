import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Container } from "@azure/cosmos";
import type { Request, Response } from "express";

import { updateMessageChartSpecEndpoint } from "../controllers/sessionController.js";
import { type ChatDocument } from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";

/**
 * W5 · drives the REAL per-message chart-spec PATCH controller against a fake
 * Cosmos container (no network). Proves the parity toolbar's view-side
 * mutations (mark switch / stacked-grouped / show-labels / Top-N limit) land on
 * message.charts[i] via the mutateChatDocument seam, that leaving bar strips the
 * bar-only fields, that limit:null clears, and that bad input is rejected.
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

function makeReq(params: Record<string, string>, body: unknown): Request {
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

const firstChart = (stored: ChatDocument) =>
  (stored.messages[0] as { charts: Array<Record<string, unknown>> }).charts[0];

afterEach(() => {
  __setContainerForTesting(null);
  __resetSessionWriteChainForTesting();
});

describe("updateMessageChartSpecEndpoint (W5)", () => {
  it("persists barLayout + dataLabels + limit onto the chart", async () => {
    const sessionId = "spec-ep-happy";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [
        { type: "bar", title: "t", x: "Region", y: "Sales", seriesColumn: "Year" },
      ]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { spec: { barLayout: "grouped", dataLabels: false, limit: { mode: "top", n: 10 } } },
      ),
      res,
    );

    assert.equal(res.statusCode, 200);
    const chart = firstChart(fake.current()!);
    assert.equal(chart.barLayout, "grouped");
    assert.equal(chart.dataLabels, false);
    assert.deepEqual(chart.limit, { mode: "top", n: 10 });
  });

  it("strips bar-only barLayout + sort when switching the mark away from bar", async () => {
    const sessionId = "spec-ep-mark";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [
        {
          type: "bar",
          title: "t",
          x: "Month",
          y: "Sales",
          barLayout: "stacked",
          sort: { by: "value", direction: "desc" },
        },
      ]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { spec: { type: "line" } },
      ),
      res,
    );

    assert.equal(res.statusCode, 200);
    const chart = firstChart(fake.current()!);
    assert.equal(chart.type, "line");
    assert.equal(chart.barLayout, undefined);
    assert.equal(chart.sort, undefined);
  });

  it("clears the Top/Bottom-N selection on limit:null", async () => {
    const sessionId = "spec-ep-clearlimit";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [
        { type: "bar", title: "t", x: "Region", y: "Sales", limit: { mode: "top", n: 5 } },
      ]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { spec: { limit: null } },
      ),
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(firstChart(fake.current()!).limit, undefined);
  });

  it("rejects an empty spec with 400", async () => {
    const sessionId = "spec-ep-empty";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Region", y: "Sales" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq({ sessionId, messageTimestamp: "1000", chartIndex: "0" }, { spec: {} }),
      res,
    );
    assert.equal(res.statusCode, 400);
  });

  it("rejects an unknown field / bad value with 400 (strict schema)", async () => {
    const sessionId = "spec-ep-bad";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Region", y: "Sales" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { spec: { type: "not-a-chart-type" } },
      ),
      res,
    );
    assert.equal(res.statusCode, 400);
  });

  it("returns 404 for an out-of-range chartIndex", async () => {
    const sessionId = "spec-ep-badidx";
    const fake = makeFakeContainer(
      buildDoc(sessionId, [{ type: "bar", title: "t", x: "Region", y: "Sales" }]),
    );
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "5" },
        { spec: { dataLabels: true } },
      ),
      res,
    );
    assert.equal(res.statusCode, 404);
  });

  it("reports an ownership denial as 403, not 500", async () => {
    const sessionId = "spec-ep-403";
    const doc = buildDoc(sessionId, [
      { type: "bar", title: "t", x: "Region", y: "Sales" },
    ]);
    doc.username = "someone-else@x.com";
    doc.collaborators = ["someone-else@x.com"];
    const fake = makeFakeContainer(doc);
    __setContainerForTesting(fake.container);

    const res = makeRes();
    await updateMessageChartSpecEndpoint(
      makeReq(
        { sessionId, messageTimestamp: "1000", chartIndex: "0" },
        { spec: { dataLabels: true } },
      ),
      res,
    );
    assert.equal(res.statusCode, 403);
  });
});
