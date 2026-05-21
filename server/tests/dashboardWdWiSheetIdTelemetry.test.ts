/**
 * Wave WD3-WI4-sheetId-telemetry · server-side tests for the optional
 * `sheetId` field on both observability endpoints
 * (`POST /api/telemetry/drill-through` + `POST /api/telemetry/explain-slice`).
 *
 * The two endpoints widen in lockstep — the per-sheet `chartId`
 * (`"chart-N"`) on the client is locally unique within a sheet but
 * globally collides across sheets in a multi-sheet dashboard, so Cosmos
 * aggregations like `GROUP BY chartId` silently combine clicks from
 * different sheets unless `sheetId` rides alongside.
 *
 * Pins five contracts per endpoint:
 *  1. The schema accepts requests carrying `sheetId`.
 *  2. The schema rejects an empty-string `sheetId` (the `.min(1)` floor).
 *  3. The schema rejects non-string `sheetId` (the type guard floor).
 *  4. The controller threads `sheetId` into `metadata` when present.
 *  5. The controller OMITS `sheetId` from `metadata` when absent — NOT
 *     `sheetId: undefined` — so Cosmos rows stay byte-identical to the
 *     pre-wave shape for callers that don't yet pass it (the
 *     explicit-omit invariant, codified by the dashboardId-omit pattern
 *     in the prior WD3/WI4 controller tests).
 *
 * Plus two source-inspection pins so the doublet widening can't drift
 * apart in a future edit (one schema gains `sheetId` while the other
 * doesn't, or only one controller threads it through).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  drillThroughTelemetryController,
  drillThroughTelemetryRequestSchema,
  explainSliceTelemetryController,
  explainSliceTelemetryRequestSchema,
  __setUsageEventRecorderForTesting,
  __resetUsageEventRecorderForTesting,
} from "../routes/telemetry.js";
import type { recordUsageEvent } from "../models/usageEvent.model.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const telemetryRouteSrc = readFileSync(
  repoFile("../routes/telemetry.ts"),
  "utf-8",
);

function fakeRes(): Response & {
  _status?: number;
  _body?: unknown;
  _sendCalled?: boolean;
} {
  const r: any = {};
  r._status = 200;
  r.status = (code: number) => {
    r._status = code;
    return r;
  };
  r.json = (b: unknown) => {
    r._body = b;
    return r;
  };
  r.send = () => {
    r._sendCalled = true;
    return r;
  };
  return r;
}

function fakeReq(args: { email?: string; body?: unknown }): Request {
  return {
    auth: args.email ? { email: args.email } : undefined,
    headers: {},
    body: args.body ?? {},
    params: {},
  } as unknown as Request;
}

describe("WD3-WI4-sheetId-telemetry · drillThroughTelemetryRequestSchema", () => {
  it("accepts a request carrying sheetId alongside the canonical fields", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "spend",
      valueType: "number",
      dashboardId: "dashboard-abc",
      sheetId: "sheet-overview",
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.sheetId, "sheet-overview");
    }
  });

  it("rejects an empty-string sheetId (min(1) floor)", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "spend",
      valueType: "number",
      sheetId: "",
    });
    assert.equal(r.success, false);
  });

  it("rejects a non-string sheetId (type guard floor)", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "spend",
      valueType: "number",
      sheetId: 42,
    });
    assert.equal(r.success, false);
  });
});

describe("WD3-WI4-sheetId-telemetry · explainSliceTelemetryRequestSchema", () => {
  it("accepts a request carrying sheetId alongside the canonical fields", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "month",
      regionKind: "temporal",
      dashboardId: "dashboard-abc",
      sheetId: "sheet-details",
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.sheetId, "sheet-details");
    }
  });

  it("rejects an empty-string sheetId (min(1) floor)", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "month",
      regionKind: "temporal",
      sheetId: "",
    });
    assert.equal(r.success, false);
  });

  it("rejects a non-string sheetId (type guard floor)", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-2",
      column: "month",
      regionKind: "temporal",
      sheetId: 42,
    });
    assert.equal(r.success, false);
  });
});

describe("WD3-WI4-sheetId-telemetry · drillThroughTelemetryController", () => {
  let recordedCalls: Array<Parameters<typeof recordUsageEvent>[0]>;

  beforeEach(() => {
    recordedCalls = [];
    __setUsageEventRecorderForTesting((input) => {
      recordedCalls.push(input);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    __resetUsageEventRecorderForTesting();
  });

  it("threads sheetId into recorder metadata when the request carries it", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-0",
        column: "category",
        valueType: "string",
        dashboardId: "dashboard-abc",
        sheetId: "sheet-overview",
      },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.eventType, "dashboard.drill-through");
    assert.equal(call.userEmail, "user@example.com");
    assert.equal(call.dashboardId, "dashboard-abc");
    assert.deepEqual(call.metadata, {
      chartId: "chart-0",
      column: "category",
      valueType: "string",
      sheetId: "sheet-overview",
    });
  });

  it("OMITS sheetId from recorder metadata when the request omits it (explicit-omit invariant — NOT sheetId: undefined)", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-0",
        column: "category",
        valueType: "string",
        dashboardId: "dashboard-abc",
      },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.deepEqual(call.metadata, {
      chartId: "chart-0",
      column: "category",
      valueType: "string",
    });
    // The key MUST be absent, not present-with-undefined — Cosmos
    // distinguishes `{}` from `{sheetId: undefined}` on the wire.
    assert.equal(
      Object.prototype.hasOwnProperty.call(call.metadata, "sheetId"),
      false,
    );
  });
});

describe("WD3-WI4-sheetId-telemetry · explainSliceTelemetryController", () => {
  let recordedCalls: Array<Parameters<typeof recordUsageEvent>[0]>;

  beforeEach(() => {
    recordedCalls = [];
    __setUsageEventRecorderForTesting((input) => {
      recordedCalls.push(input);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    __resetUsageEventRecorderForTesting();
  });

  it("threads sheetId into recorder metadata when the request carries it", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-0",
        column: "spend",
        regionKind: "box2d",
        dashboardId: "dashboard-abc",
        sheetId: "sheet-details",
      },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.eventType, "dashboard.explain-slice");
    assert.equal(call.userEmail, "user@example.com");
    assert.equal(call.dashboardId, "dashboard-abc");
    assert.deepEqual(call.metadata, {
      chartId: "chart-0",
      column: "spend",
      regionKind: "box2d",
      sheetId: "sheet-details",
    });
  });

  it("OMITS sheetId from recorder metadata when the request omits it (explicit-omit invariant)", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-0",
        column: "spend",
        regionKind: "numeric",
      },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.deepEqual(call.metadata, {
      chartId: "chart-0",
      column: "spend",
      regionKind: "numeric",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(call.metadata, "sheetId"),
      false,
    );
  });
});

describe("WD3-WI4-sheetId-telemetry · doublet drift guard (source inspection)", () => {
  it("both request schemas declare sheetId as z.string().min(1).optional()", () => {
    // Two separate `sheetId: z.string().min(1).optional()` occurrences
    // pin that both schemas got the same widening. If a future edit
    // tightens one (e.g. drops .optional()) without the other, this
    // breaks.
    const matches = telemetryRouteSrc.match(
      /sheetId:\s*z\.string\(\)\.min\(1\)\.optional\(\)/g,
    );
    assert.equal(matches?.length, 2);
  });

  it("both controllers spread sheetId into metadata conditionally (...(sheetId ? {sheetId} : {}))", () => {
    // Pins the explicit-omit invariant at the source level — both
    // controllers must use the conditional spread, never an
    // unconditional `sheetId,` field (which would write
    // `sheetId: undefined` to Cosmos when absent).
    const matches = telemetryRouteSrc.match(
      /\.\.\.\(sheetId\s*\?\s*\{\s*sheetId\s*\}\s*:\s*\{\s*\}\)/g,
    );
    assert.equal(matches?.length, 2);
  });
});
