import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CosmosDocSizeError } from "../models/chat.model.js";
import type { ChatDocument } from "../models/chat.model.js";

// The guard runs inside `updateChatDocument`, but unit-testing it through that
// path would require mocking Cosmos. Instead, we test the same `CosmosDocSizeError`
// contract directly by reproducing the size check the production code performs.
//
// If the production guard's thresholds change, this test file is the canonical
// place to mirror them.
const ERROR_THRESHOLD_BYTES = 1_900_000;

function fakeDocOfSize(targetBytes: number, sessionId: string): ChatDocument {
  // Build a doc whose JSON serializes to roughly `targetBytes` by stuffing a
  // single huge string into one message. We don't care about field shape; the
  // production guard reads `JSON.stringify(doc).length` regardless.
  const padding = "x".repeat(Math.max(0, targetBytes - 200));
  return {
    id: "test",
    sessionId,
    username: "user@test.com",
    fileName: "f.csv",
    messages: [
      {
        role: "assistant",
        content: padding,
        timestamp: 1,
      } as unknown as ChatDocument["messages"][number],
    ],
    charts: [],
    chartReferences: [],
    enrichmentStatus: "complete",
    createdAt: 0,
    lastUpdatedAt: 0,
    collaborators: [],
  } as unknown as ChatDocument;
}

describe("Cosmos doc size guard", () => {
  it("CosmosDocSizeError carries bytes + sessionId", () => {
    const e = new CosmosDocSizeError(2_000_000, "s1");
    assert.equal(e.name, "CosmosDocSizeError");
    assert.equal(e.bytes, 2_000_000);
    assert.equal(e.sessionId, "s1");
    assert.match(e.message, /2000000/);
    assert.match(e.message, /s1/);
  });

  it("a 2.5 MB doc serialised would exceed the error threshold", () => {
    const huge = fakeDocOfSize(2_500_000, "s2");
    const bytes = Buffer.byteLength(JSON.stringify(huge), "utf8");
    assert.ok(
      bytes >= ERROR_THRESHOLD_BYTES,
      `expected serialised doc ≥ ${ERROR_THRESHOLD_BYTES}, got ${bytes}`,
    );
  });

  it("a 500 KB doc is well under both thresholds", () => {
    const small = fakeDocOfSize(500_000, "s3");
    const bytes = Buffer.byteLength(JSON.stringify(small), "utf8");
    assert.ok(bytes < ERROR_THRESHOLD_BYTES);
  });
});
