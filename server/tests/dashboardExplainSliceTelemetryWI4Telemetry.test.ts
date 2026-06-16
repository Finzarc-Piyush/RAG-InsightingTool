/**
 * Wave WI4-telemetry · server-side tests for POST /api/telemetry/explain-slice.
 *
 * Validates the body schema (with regionKind as a 4-value z.enum rather
 * than WD3's free-form `valueType` string), the auth gate, and the
 * fire-and-forget invocation of `recordUsageEvent` with the canonical
 * `eventType` / `userEmail` / `dashboardId` / `metadata` shape.
 *
 * Reuses the shared route-level recorder seam (`__setUsageEventRecorderForTesting`
 * / `__resetUsageEventRecorderForTesting`) that WD3-telemetry introduced —
 * this is the second consumer of that seam, which makes it a now-codified
 * convention for observability endpoints (see
 * `docs/conventions/route-level-recorder-seam.md`).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  explainSliceTelemetryController,
  explainSliceTelemetryRequestSchema,
  __setUsageEventRecorderForTesting,
  __resetUsageEventRecorderForTesting,
} from "../routes/telemetry.js";
import type { recordUsageEvent } from "../models/usageEvent.model.js";
import { usageEventTypeSchema } from "../shared/schema.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const telemetryRouteSrc = readFileSync(
  repoFile("../routes/telemetry.ts"),
  "utf-8",
);

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

describe("WI4-telemetry · explainSliceTelemetryRequestSchema", () => {
  it("parses a minimal valid request (required fields only, regionKind: numeric)", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "spend",
      regionKind: "numeric",
    });
    assert.equal(r.success, true);
  });

  it("parses a request with optional dashboardId", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "month",
      regionKind: "temporal",
      dashboardId: "dashboard-abc",
    });
    assert.equal(r.success, true);
  });

  it("rejects empty chartId", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "",
      column: "spend",
      regionKind: "numeric",
    });
    assert.equal(r.success, false);
  });

  it("rejects missing column", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      regionKind: "numeric",
    });
    assert.equal(r.success, false);
  });

  it("rejects missing regionKind", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "spend",
    });
    assert.equal(r.success, false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "spend",
      regionKind: "numeric",
      regionStart: 0, // raw bounds must never go on the wire
    });
    assert.equal(r.success, false);
  });

  it("rejects unknown regionKind enum values (e.g. 'rectangle')", () => {
    const r = explainSliceTelemetryRequestSchema.safeParse({
      chartId: "chart-3",
      column: "spend",
      regionKind: "rectangle",
    });
    assert.equal(r.success, false);
  });
});

describe("WI4-telemetry · explainSliceTelemetryController", () => {
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
        column: "category",
        regionKind: "categorical",
        dashboardId: "dashboard-abc",
      },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 204);
    assert.equal(res._sendCalled, true);

    // Microtask flush so the void recordUsageEvent(...) call settles.
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.eventType, "dashboard.explain-slice");
    assert.equal(call.userEmail, "user@example.com");
    assert.equal(call.dashboardId, "dashboard-abc");
    assert.deepEqual(call.metadata, {
      chartId: "chart-3",
      column: "category",
      regionKind: "categorical",
    });
  });

  it("returns 204 and omits dashboardId from the call when the request omits it (regionKind: box2d)", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-5",
        column: "spend",
        regionKind: "box2d",
      },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 204);
    await Promise.resolve();

    assert.equal(recordedCalls.length, 1);
    const call = recordedCalls[0]!;
    assert.equal(call.dashboardId, undefined);
    assert.equal((call.metadata as { regionKind?: string }).regionKind, "box2d");
  });

  it("returns 401 when auth context is missing and does NOT fire recordUsageEvent", async () => {
    const req = fakeReq({
      body: { chartId: "chart-3", column: "spend", regionKind: "numeric" },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 401);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });

  it("returns 400 when body is malformed and does NOT fire recordUsageEvent", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: { chartId: "chart-3" }, // missing column + regionKind
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 400);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });

  it("returns 400 when body has extra keys (strict schema rejects PII leak attempts)", async () => {
    const req = fakeReq({
      email: "user@example.com",
      body: {
        chartId: "chart-3",
        column: "spend",
        regionKind: "numeric",
        regionStart: 100, // raw bounds — never send
        regionEnd: 500,
      },
    });
    const res = fakeRes();
    await explainSliceTelemetryController(req, res);
    assert.equal(res._status, 400);
    await Promise.resolve();
    assert.equal(recordedCalls.length, 0);
  });
});

describe("WI4-telemetry · schema enum + route registration wiring", () => {
  it("usageEventTypeSchema enum includes 'dashboard.explain-slice'", () => {
    assert.equal(
      usageEventTypeSchema.safeParse("dashboard.explain-slice").success,
      true,
    );
  });

  it("telemetry.ts registers POST /telemetry/explain-slice with the controller", () => {
    assert.match(
      telemetryRouteSrc,
      /router\.post\(\s*["']\/telemetry\/explain-slice["']\s*,\s*explainSliceTelemetryController\s*\)/,
    );
  });

  it("routes/index.ts mounts the shared telemetry router under /api (covers both WD3 + WI4 paths)", () => {
    // API-7: the `mount('', telemetryRoutes)` helper registers both `/api` and
    // its `/api/v1` alias to the same router.
    assert.match(
      routesIndexSrc,
      /mount\(\s*['"]['"]\s*,\s*telemetryRoutes\s*\)/,
    );
  });
});
