/**
 * Wave WD3-telemetry · server-side tests for POST /api/telemetry/drill-through.
 *
 * Validates the body schema, auth gate, and the fire-and-forget invocation
 * of `recordUsageEvent` with the correct `eventType` / `userEmail` /
 * `dashboardId` / `metadata` shape. The model itself owns the Cosmos write
 * path and is covered by its own tests; here we pin only the route
 * contract.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  drillThroughTelemetryController,
  drillThroughTelemetryRequestSchema,
  __setUsageEventRecorderForTesting,
  __resetUsageEventRecorderForTesting,
} from "../routes/telemetry.js";
import type { recordUsageEvent } from "../models/usageEvent.model.js";
import { usageEventTypeSchema } from "../shared/schema.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const routesIndexSrc = readFileSync(
  repoFile("../routes/index.ts"),
  "utf-8",
);

function fakeRes(): Response & { _status?: number; _body?: unknown; _sendCalled?: boolean } {
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

describe("WD3-telemetry · drillThroughTelemetryRequestSchema", () => {
  it("parses a minimal valid request (required fields only)", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "region",
      valueType: "string",
    });
    assert.equal(r.success, true);
  });

  it("parses a request with optional dashboardId", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "region",
      valueType: "string",
      dashboardId: "dashboard-abc",
    });
    assert.equal(r.success, true);
  });

  it("rejects empty chartId", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "",
      column: "region",
      valueType: "string",
    });
    assert.equal(r.success, false);
  });

  it("rejects missing column", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      valueType: "string",
    });
    assert.equal(r.success, false);
  });

  it("rejects missing valueType", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "region",
    });
    assert.equal(r.success, false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "region",
      valueType: "string",
      pii: "should not pass",
    });
    assert.equal(r.success, false);
  });

  it("rejects non-string chartId", () => {
    const r = drillThroughTelemetryRequestSchema.safeParse({
      chartId: 42,
      column: "region",
      valueType: "string",
    });
    assert.equal(r.success, false);
  });
});

describe("WD3-telemetry · drillThroughTelemetryController", () => {
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

  it("returns 204 on happy path and fires recordUsageEvent with the canonical shape", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-3",
        column: "region",
        valueType: "string",
        dashboardId: "dashboard-abc",
      },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 204);
    assert.equal(res._sendCalled, true);

    // Microtask flush so the void recordUsageEvent(...) call settles.
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.eventType, "dashboard.drill-through");
    assert.equal(call.userEmail, "user@example.com");
    assert.equal(call.dashboardId, "dashboard-abc");
    assert.deepEqual(call.metadata, {
      chartId: "chart-3",
      column: "region",
      valueType: "string",
    });
  });

  it("returns 204 and omits dashboardId from the call when the request omits it", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-3",
        column: "region",
        valueType: "number",
      },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.dashboardId, undefined);
    assert.equal(call.metadata?.valueType, "number");
  });

  it("returns 401 when auth context is missing and does NOT fire recordUsageEvent", async () => {
    const req = fakeReq({
      body: { chartId: "chart-3", column: "region", valueType: "string" },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 401);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });

  it("returns 400 when body is malformed and does NOT fire recordUsageEvent", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: { chartId: "chart-3" }, // missing column + valueType
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 400);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });

  it("returns 400 when body has extra keys (strict schema)", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-3",
        column: "region",
        valueType: "string",
        value: "North America — never send raw values",
      },
    });
    const res = fakeRes();
    await drillThroughTelemetryController(req, res);
    assert.equal(res._status, 400);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });
});

describe("WD3-telemetry · schema enum + route registration wiring", () => {
  it("usageEventTypeSchema enum includes 'dashboard.drill-through'", () => {
    assert.equal(
      usageEventTypeSchema.safeParse("dashboard.drill-through").success,
      true,
    );
  });

  it("routes/index.ts imports the telemetry router", () => {
    assert.match(
      routesIndexSrc,
      /import\s+telemetryRoutes\s+from\s+["']\.\/telemetry\.js["']/,
    );
  });

  it("routes/index.ts mounts telemetryRoutes under /api", () => {
    // API-7: routers are mounted via the `mount('<subpath>', router)` helper,
    // which registers BOTH `/api<subpath>` and a `/api/v1<subpath>` alias.
    // An empty subpath ('') means the router is mounted at `/api` (+ `/api/v1`).
    assert.match(
      routesIndexSrc,
      /mount\(\s*['"]['"]\s*,\s*telemetryRoutes\s*\)/,
    );
  });
});
