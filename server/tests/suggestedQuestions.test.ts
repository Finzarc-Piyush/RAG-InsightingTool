import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSuggestedQuestions } from "../lib/suggestedQuestions.js";

describe("mergeSuggestedQuestions", () => {
  it("returns primary unchanged when primary is non-empty; fallback is ignored", () => {
    const merged = mergeSuggestedQuestions(
      ["What drives sales?", "Show monthly trend"],
      ["Show monthly trend", "What segments are growing?"]
    );
    assert.deepEqual(merged, [
      "What drives sales?",
      "Show monthly trend",
    ]);
  });

  it("uses fallback only when primary is empty", () => {
    const merged = mergeSuggestedQuestions([], ["Template Q1", "Template Q2"]);
    assert.deepEqual(merged, ["Template Q1", "Template Q2"]);
  });

  it("short non-empty primary is NOT padded with fallback", () => {
    const merged = mergeSuggestedQuestions(
      ["Q1", "Q2", "Q3"],
      ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]
    );
    assert.deepEqual(merged, ["Q1", "Q2", "Q3"]);
  });

  it("deduplicates within primary", () => {
    const merged = mergeSuggestedQuestions(
      ["Q1", "Q2", "Q1", "Q3"],
      ["P1"]
    );
    assert.deepEqual(merged, ["Q1", "Q2", "Q3"]);
  });

  it("respects the configured limit", () => {
    const merged = mergeSuggestedQuestions(
      Array.from({ length: 10 }, (_, i) => `Q${i + 1}`),
      [],
      5
    );
    assert.equal(merged.length, 5);
    assert.deepEqual(merged, ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  });

  it("treats undefined/null inputs as empty", () => {
    assert.deepEqual(mergeSuggestedQuestions(undefined, ["F1"]), ["F1"]);
    assert.deepEqual(mergeSuggestedQuestions([], undefined), []);
    assert.deepEqual(mergeSuggestedQuestions(undefined, undefined), []);
  });
});
