import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertPastAnalysisDoc } from "../models/pastAnalysis.model.js";
import type { PastAnalysisDoc } from "../shared/schema.js";

/**
 * W2.2 · The model file is mostly Cosmos plumbing. This test pins the one
 * behaviour that does NOT require a live container: the Zod validation guard
 * must reject malformed payloads before any network call happens. The happy
 * path is covered by the schema test (pastAnalysisSchema.test.ts) and by
 * integration-level verification in W2.3's end-to-end test.
 */

describe("upsertPastAnalysisDoc · validation guard", () => {
  it("rejects a malformed doc before any Cosmos call is attempted", async () => {
    // Missing most required fields — the async should reject with the
    // 'Invalid PastAnalysisDoc' message, NOT with a Cosmos-connection error.
    const bad = { id: "x" } as unknown as PastAnalysisDoc;
    await assert.rejects(
      () => upsertPastAnalysisDoc(bad),
      /Invalid PastAnalysisDoc/
    );
  });

  it("rejects a doc with negative costUsd", async () => {
    const bad = {
      id: "s__t",
      sessionId: "s",
      userId: "u@example.com",
      turnId: "t",
      dataVersion: 1,
      question: "q",
      normalizedQuestion: "q",
      answer: "a",
      costUsd: -1,
      latencyMs: 10,
      tokenTotals: { input: 1, output: 1 },
      outcome: "ok",
      createdAt: 1,
    } as unknown as PastAnalysisDoc;
    await assert.rejects(
      () => upsertPastAnalysisDoc(bad),
      /Invalid PastAnalysisDoc/
    );
  });
});
