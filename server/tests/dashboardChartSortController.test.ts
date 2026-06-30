import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

import { updateChartInsightOrRecommendationController } from "../controllers/dashboardController.js";

/**
 * Wave S6 · the chart PATCH controller now accepts EITHER a keyInsight or a
 * sort patch. These cover the new validation branches that return BEFORE any
 * Cosmos call (the happy-path dual-write is exercised by the integration suite,
 * mirroring the long-standing keyInsight write).
 */

function makeReq(body: unknown): Request {
  return {
    params: { dashboardId: "d1", chartIndex: "0" },
    body,
    headers: { "x-user-email": "u@x.com" },
    auth: { email: "u@x.com" },
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

describe("updateChartInsightOrRecommendationController · validation (Wave S6)", () => {
  it("rejects with 400 when neither keyInsight, sort, nor limit is provided", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(makeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  it("rejects with 400 when the sort payload is invalid", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ sort: { by: "nonsense", direction: "asc" } }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid sort payload/);
  });

  it("rejects with 400 when the limit payload is invalid (bad mode)", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ limit: { mode: "sideways", n: 5 } }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid limit payload/);
  });

  it("rejects with 400 when the limit n is not a positive integer", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ limit: { mode: "top", n: 0 } }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid limit payload/);
  });
});

describe("updateChartInsightOrRecommendationController · W6 parity-toolbar validation", () => {
  it("rejects with 400 when an unknown chart type is provided", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ type: "not-a-chart-type" }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid type payload/);
  });

  it("rejects with 400 when barLayout is neither stacked nor grouped", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ barLayout: "diagonal" }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid barLayout payload/);
  });

  it("rejects with 400 when dataLabels is not a boolean", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(
      makeReq({ dataLabels: "yes" }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid dataLabels payload/);
  });

  it("the all-absent rejection message now lists the W6 fields", async () => {
    const res = makeRes();
    await updateChartInsightOrRecommendationController(makeReq({}), res);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /type, barLayout, or dataLabels/);
  });
});
