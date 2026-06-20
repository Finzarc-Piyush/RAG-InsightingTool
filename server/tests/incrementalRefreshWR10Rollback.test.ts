/**
 * Wave WR10 (incremental refresh) · user-initiated rollback.
 *
 * The rollback restore itself is Cosmos I/O (covered by manual E2E). This pins
 * the pure `buildRefreshHistoryView` that drives the "Data: as of …" badge —
 * canRollback + current/prior version+label — and the endpoint flag-gating.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRefreshHistoryView } from "../lib/refresh/rollbackRefresh.service.js";
import { refreshRollbackController } from "../controllers/refreshController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { Request, Response } from "express";

describe("WR10 · buildRefreshHistoryView", () => {
  it("reports canRollback + current/prior labels from the snapshot", () => {
    const chat = {
      currentDataBlob: { version: 2 } as ChatDocument["currentDataBlob"],
      dataVersions: [
        { versionId: "v1", label: "as of Apr 2026" },
        { versionId: "v2", label: "as of May 2026" },
      ],
      messageVersions: [
        {
          versionId: "m1",
          snapshotAt: 1,
          label: "as of Apr 2026",
          messages: [],
          priorDataBlob: { version: 1 } as ChatDocument["currentDataBlob"],
        },
      ],
    } as unknown as ChatDocument;

    const view = buildRefreshHistoryView(chat);
    assert.equal(view.canRollback, true);
    assert.equal(view.currentVersion, 2);
    assert.equal(view.currentLabel, "as of May 2026");
    assert.equal(view.priorVersion, 1);
    assert.equal(view.priorLabel, "as of Apr 2026");
  });

  it("canRollback is false when there's no snapshot", () => {
    const chat = { currentDataBlob: { version: 1 } } as unknown as ChatDocument;
    assert.equal(buildRefreshHistoryView(chat).canRollback, false);
  });
});

describe("WR10 · rollback endpoint gating", () => {
  it("returns 404 when the flag is OFF", async () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      const out: { statusCode?: number } = {};
      const res = {
        status(c: number) {
          out.statusCode = c;
          return this;
        },
        json() {
          return this;
        },
      } as unknown as Response;
      await refreshRollbackController(
        { params: { sessionId: "s1" }, body: {} } as unknown as Request,
        res
      );
      assert.equal(out.statusCode, 404);
    } finally {
      if (prev !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });
});
