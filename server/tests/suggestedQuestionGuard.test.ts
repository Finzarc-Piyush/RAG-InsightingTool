import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasDisjunctiveOr,
  stripOrQuestions,
} from "../lib/suggestedQuestionGuard.js";
import { suggestedFollowUpsFromDataSummary } from "../lib/suggestedFollowUpsFromSummary.js";
import { mergeSuggestedQuestions } from "../lib/suggestedQuestions.js";
import { filterSpawnedQuestions } from "../lib/agents/runtime/filterSpawnedQuestions.js";
import {
  deepenFollowUps,
  filterAnsweredFollowUps,
} from "../shared/followUpDeepening.js";
import type { DataSummary } from "../shared/schema.js";

describe("suggestedQuestionGuard.hasDisjunctiveOr", () => {
  it("flags the standalone conjunction 'or' (incl. 'and/or' and uppercase)", () => {
    assert.equal(hasDisjunctiveOr("What is sales distribution by cluster or state?"), true);
    assert.equal(hasDisjunctiveOr("Show revenue and/or volume by region"), true);
    assert.equal(hasDisjunctiveOr("Is it A OR B?"), true);
  });

  it("never matches the letters 'or' inside a larger word", () => {
    // for / store / factor / category / region / report all contain "or"-ish
    // substrings but no word boundary — these must pass through untouched.
    for (const q of [
      "What drives sales for each store?",
      "Which factor explains the category gap?",
      "How does revenue trend by region in the latest report?",
      "What is the correlation between price and demand?", // "correlation" contains 'or'
    ]) {
      assert.equal(hasDisjunctiveOr(q), false, q);
    }
  });

  it("treats null/undefined/empty as not-disjunctive", () => {
    assert.equal(hasDisjunctiveOr(null), false);
    assert.equal(hasDisjunctiveOr(undefined), false);
    assert.equal(hasDisjunctiveOr(""), false);
  });
});

describe("suggestedQuestionGuard.stripOrQuestions", () => {
  it("drops disjunctive questions, preserves order, drops blanks/non-strings", () => {
    const input = [
      "How has revenue trended over time?",
      "Compare A or B by cluster",
      "  ",
      "Which region leads on margin?",
      "Split by cluster or state",
    ] as string[];
    assert.deepEqual(stripOrQuestions(input), [
      "How has revenue trended over time?",
      "Which region leads on margin?",
    ]);
  });

  it("returns [] for nullish input", () => {
    assert.deepEqual(stripOrQuestions(undefined), []);
    assert.deepEqual(stripOrQuestions(null), []);
  });
});

function makeSummary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 3,
    columns: [
      { name: "Region", type: "string" },
      { name: "Sales", type: "number" },
      { name: "Month", type: "date" },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Month"],
  } as unknown as DataSummary;
}

describe("suggestedFollowUpsFromDataSummary (no 'or' in templates)", () => {
  it("never emits a disjunctive question (was 'top categories or values')", () => {
    const out = suggestedFollowUpsFromDataSummary(makeSummary());
    assert.ok(out.length > 0);
    for (const q of out) assert.equal(hasDisjunctiveOr(q), false, q);
    // The categorical template now reads "most common values", not "categories or values".
    assert.ok(out.some((q) => q.includes("most common values for Region")));
  });
});

describe("mergeSuggestedQuestions backstop", () => {
  it("strips disjunctive entries from the primary list", () => {
    const merged = mergeSuggestedQuestions(
      ["Good one about margin", "Bad one by cluster or state"],
      ["fallback"]
    );
    assert.deepEqual(merged, ["Good one about margin"]);
  });

  it("falls through to fallback (also stripped) when primary is all-disjunctive", () => {
    const merged = mergeSuggestedQuestions(
      ["only A or B"],
      ["clean fallback", "dirty C or D"]
    );
    assert.deepEqual(merged, ["clean fallback"]);
  });
});

describe("followUpDeepening drops disjunctive prompts at render time", () => {
  it("filterAnsweredFollowUps strips an 'or' prompt (server path)", () => {
    const out = filterAnsweredFollowUps(
      ["What explains the margin gap?", "Break down by cluster or state"],
      []
    );
    assert.deepEqual(out, ["What explains the margin gap?"]);
  });

  it("deepenFollowUps drops a legacy stored 'or' prompt (dashboard render)", () => {
    // No charts → stored list is passed through trimmed; the "or" one must go.
    const out = deepenFollowUps(
      ["What is driving the decline?", "Compare A or B by region"],
      []
    );
    assert.deepEqual(out, ["What is driving the decline?"]);
  });
});

describe("filterSpawnedQuestions drops disjunctive chips", () => {
  it("removes 'investigating further' questions that contain 'or'", () => {
    const out = filterSpawnedQuestions([
      { question: "Why is Cluster 2 NORTH 45% below average?" },
      { question: "Break the gap down by ASM or HQ" },
      { question: "Which SKU contributes most to the decline?" },
    ]);
    assert.deepEqual(
      out.map((q) => q.question),
      [
        "Why is Cluster 2 NORTH 45% below average?",
        "Which SKU contributes most to the decline?",
      ]
    );
  });
});
