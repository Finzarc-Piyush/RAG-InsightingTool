import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSuggestedQuestions } from "../lib/suggestedQuestions.js";

describe("mergeSuggestedQuestions", () => {
  it("deduplicates while preserving source order", () => {
    const merged = mergeSuggestedQuestions(
      ["What drives sales?", "Show monthly trend"],
      ["Show monthly trend", "What segments are growing?"]
    );
    assert.deepEqual(merged, [
      "What drives sales?",
      "Show monthly trend",
      "What segments are growing?",
    ]);
  });

  it("respects the configured limit", () => {
    const merged = mergeSuggestedQuestions(
      Array.from({ length: 10 }, (_, i) => `Q${i + 1}`),
      Array.from({ length: 10 }, (_, i) => `P${i + 1}`),
      5
    );
    assert.equal(merged.length, 5);
    assert.deepEqual(merged, ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  });
});
