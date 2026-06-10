import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefireEarlyQuestion,
  shouldHoldPollForRefire,
  parseQueuedQuestion,
  serializeQueuedQuestion,
  type QueuedEarlyQuestion,
} from "./earlyQuestionRefire.js";

/**
 * Locks the gating-signal decision for re-firing an early question:
 * re-fire ONLY on `status === 'completed'` (data fully materialized), never on
 * the early `enrichmentStatus === 'complete'` / `understandingReady` signals.
 */
describe("shouldRefireEarlyQuestion", () => {
  const q: QueuedEarlyQuestion = { content: "Why did sales drop?", timestamp: 123 };

  it("re-fires only when status==='completed' AND a question is queued", () => {
    assert.equal(shouldRefireEarlyQuestion({ status: "completed" }, q), true);
  });

  it("does NOT re-fire when nothing is queued", () => {
    assert.equal(shouldRefireEarlyQuestion({ status: "completed" }, null), false);
  });

  it("does NOT re-fire on the early enrichmentStatus signal alone", () => {
    // The poll may report status 'analyzing'/'saving' while enrichmentStatus is
    // already 'complete' (understanding checkpoint). Must not re-fire yet.
    assert.equal(shouldRefireEarlyQuestion({ status: "analyzing" }, q), false);
    assert.equal(shouldRefireEarlyQuestion({ status: "saving" }, q), false);
    assert.equal(shouldRefireEarlyQuestion({ status: undefined }, q), false);
  });
});

describe("shouldHoldPollForRefire", () => {
  it("keeps polling while a question is queued and not yet truly completed", () => {
    assert.equal(shouldHoldPollForRefire({ status: "analyzing" }, true), true);
    assert.equal(shouldHoldPollForRefire({ status: "saving" }, true), true);
  });

  it("stops holding once status==='completed'", () => {
    assert.equal(shouldHoldPollForRefire({ status: "completed" }, true), false);
  });

  it("never holds when nothing is queued (preserves today's stop-early behavior)", () => {
    assert.equal(shouldHoldPollForRefire({ status: "analyzing" }, false), false);
  });
});

describe("queued-question serialization round-trip", () => {
  it("serialize -> parse yields the same content+timestamp", () => {
    const q: QueuedEarlyQuestion = { content: "Top SKUs by margin?", timestamp: 999 };
    const restored = parseQueuedQuestion(JSON.parse(serializeQueuedQuestion(q)));
    assert.deepEqual(restored, q);
  });

  it("rejects malformed payloads", () => {
    assert.equal(parseQueuedQuestion(null), null);
    assert.equal(parseQueuedQuestion({ content: "", timestamp: 1 }), null);
    assert.equal(parseQueuedQuestion({ content: "x" }), null);
    assert.equal(parseQueuedQuestion({ content: "x", timestamp: "1" }), null);
    assert.equal(parseQueuedQuestion({ timestamp: 1 }), null);
  });
});
