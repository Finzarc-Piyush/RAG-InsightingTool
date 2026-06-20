/**
 * Wave WR9 (incremental refresh) · flag-gated Parquet sibling-write.
 *
 * After a refresh swaps the data, the durable Parquet sibling must be rewritten
 * so the USE_PARQUET_READ_PATH read path opens fresh (not stale) data. It is
 * DARK by default. This pins the gate: with the flag OFF, the sibling-write is a
 * no-op that never touches DuckDB/blob (so production is unchanged). The actual
 * Parquet write is covered by the sessionParquet/columnar tests + manual E2E.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maybeWriteRefreshParquet } from "../lib/refresh/ingestNewVersion.js";
import type { ChatDocument } from "../models/chat.model.js";

describe("WR9 · maybeWriteRefreshParquet gate", () => {
  it("is a no-op (resolves, no DuckDB/blob) when USE_PARQUET_READ_PATH is OFF", async () => {
    const prev = process.env.USE_PARQUET_READ_PATH;
    delete process.env.USE_PARQUET_READ_PATH;
    try {
      // A chat with a bogus session — if the gate DIDN'T early-return it would
      // try to spin up ColumnarStorageService and throw; resolving proves the gate.
      const chat = { sessionId: "no_such_session", username: "u@x.com" } as ChatDocument;
      await maybeWriteRefreshParquet(chat, [{ a: 1 }], 2);
      assert.ok(true, "resolved without touching the Parquet machinery");
    } finally {
      if (prev !== undefined) process.env.USE_PARQUET_READ_PATH = prev;
    }
  });
});
