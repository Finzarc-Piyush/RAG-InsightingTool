/**
 * Wave WR3 (incremental refresh) · controller feature-gating.
 *
 * The whole refresh surface is gated by INCREMENTAL_REFRESH_ENABLED (default
 * OFF). Both endpoints MUST be invisible (404) when the flag is off — verified
 * here without touching Cosmos, since the gate is the first statement in each
 * controller. The happy-path orchestration (ingest → replay → rollback) is
 * covered by the WR1/WR2 unit tests + the manual end-to-end in the plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  refreshController,
  refreshPreflightController,
} from "../controllers/refreshController.js";

/** Minimal chainable res stub capturing status + json. */
function mockRes() {
  const out: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.statusCode = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

const reqWith = (sessionId = "session_1") =>
  ({ params: { sessionId }, body: {} }) as unknown as Request;

describe("WR3 · refresh endpoints are gated by INCREMENTAL_REFRESH_ENABLED", () => {
  it("preflight returns 404 when the flag is OFF", async () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      const { res, out } = mockRes();
      await refreshPreflightController(reqWith(), res);
      assert.equal(out.statusCode, 404);
    } finally {
      if (prev !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });

  it("refresh (SSE) returns 404 when the flag is OFF", async () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      const { res, out } = mockRes();
      await refreshController(reqWith(), res);
      assert.equal(out.statusCode, 404);
    } finally {
      if (prev !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });
});
