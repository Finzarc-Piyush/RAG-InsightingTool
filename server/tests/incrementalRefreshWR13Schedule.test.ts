/**
 * Wave WR13 (incremental refresh) · scheduled Snowflake auto-refresh.
 *
 * The cron run + due-scan are Cosmos I/O (manual E2E). This pins the security +
 * gating of the cron endpoint, which is the part that must be correct without a
 * deploy: no CRON_SECRET → 503; wrong/no bearer → 401.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { cronRefreshController } from "../controllers/refreshController.js";

function mockRes() {
  const out: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(c: number) {
      out.statusCode = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

const reqWith = (auth?: string) =>
  ({ headers: auth ? { authorization: auth } : {} }) as unknown as Request;

describe("WR13 · cron endpoint security", () => {
  it("503 when CRON_SECRET is not configured", async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const { res, out } = mockRes();
      await cronRefreshController(reqWith("Bearer anything"), res);
      assert.equal(out.statusCode, 503);
    } finally {
      if (prev !== undefined) process.env.CRON_SECRET = prev;
    }
  });

  it("401 when the bearer token is missing or wrong", async () => {
    const prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "s3cret";
    try {
      let r = mockRes();
      await cronRefreshController(reqWith(), r.res);
      assert.equal(r.out.statusCode, 401, "no auth → 401");

      r = mockRes();
      await cronRefreshController(reqWith("Bearer wrong"), r.res);
      assert.equal(r.out.statusCode, 401, "wrong secret → 401");
    } finally {
      if (prevSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
    }
  });

  it("with a valid secret but the feature OFF, no-ops cleanly (no Cosmos scan)", async () => {
    const prevSecret = process.env.CRON_SECRET;
    const prevFlag = process.env.INCREMENTAL_REFRESH_ENABLED;
    process.env.CRON_SECRET = "s3cret";
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      const { res, out } = mockRes();
      await cronRefreshController(reqWith("Bearer s3cret"), res);
      // 200 with a skipped marker — never reached the cross-partition scan.
      assert.equal(out.statusCode, undefined); // res.json without status() = 200
      assert.equal((out.body as { due: number }).due, 0);
    } finally {
      if (prevSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
      if (prevFlag !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prevFlag;
    }
  });
});
