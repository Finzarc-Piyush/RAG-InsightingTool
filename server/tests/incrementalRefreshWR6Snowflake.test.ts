/**
 * Wave WR6 (incremental refresh) · Snowflake fetch-latest.
 *
 * The live re-query (`fetchTableData`) hits Snowflake; the controller wiring is
 * the proven shared SSE path. This file pins the pointer-gating that has no
 * external dependency:
 *   • A session with NO `snowflakeSource` rejects a fetch-latest with a clear
 *     "upload a file instead" message (rather than a cryptic connection error).
 *   • The Snowflake refresh route is gated by INCREMENTAL_REFRESH_ENABLED.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { fetchSnowflakeRefreshRows } from "../lib/refresh/ingestNewVersion.js";
import { refreshSnowflakeController } from "../controllers/refreshController.js";
import type { ChatDocument } from "../models/chat.model.js";

describe("WR6 · fetchSnowflakeRefreshRows", () => {
  it("rejects a session that isn't Snowflake-connected", async () => {
    const chat = { sessionId: "s1" } as ChatDocument; // no snowflakeSource
    await assert.rejects(
      () => fetchSnowflakeRefreshRows(chat),
      /isn't connected to Snowflake/i
    );
  });
});

describe("WR6 · refreshSnowflakeController gating", () => {
  it("returns 404 when INCREMENTAL_REFRESH_ENABLED is OFF", async () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      const out: { statusCode?: number } = {};
      const res = {
        status(code: number) {
          out.statusCode = code;
          return this;
        },
        json() {
          return this;
        },
      } as unknown as Response;
      await refreshSnowflakeController(
        { params: { sessionId: "s1" }, body: {} } as unknown as Request,
        res
      );
      assert.equal(out.statusCode, 404);
    } finally {
      if (prev !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });
});
