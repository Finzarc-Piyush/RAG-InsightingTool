import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectQuickLookup,
  isQuickLookupEnabled,
} from "../lib/agents/runtime/quickAnswerDetector.js";

/**
 * Wave QL1 · Quick-lookup detector regex/heuristic guard.
 *
 * Pins exactly which question shapes trigger the fast path. False negatives
 * are cheap (user pays the normal latency); false positives are NOT — a
 * misrouted analytical question would silently strip the analysis the user
 * expected. These tests document the conservatism contract.
 */

describe("Wave QL1 · detectQuickLookup", () => {
  describe("accepts lookup-shape questions", () => {
    const accepts = [
      "top 10 states by sales",
      "Top 10 brands by revenue",
      "highest revenue products",
      "lowest margin SKUs",
      "list customers in Texas",
      "show me bottom 5 SKUs",
      "show me the top 20 retailers",
      "how many orders last month",
      "count of unique customers",
      "average price by category",
      "max margin in 2024",
      "min sales by region",
      "latest 5 orders",
      "most recent transactions",
      "what are the top 10 states by sales?",
      "what's the highest grossing product",
      "Which 10 states sold the most?",
    ];
    for (const q of accepts) {
      it(`accepts: "${q}"`, () => {
        assert.strictEqual(
          detectQuickLookup(q),
          true,
          `Expected "${q}" to fire the fast path`
        );
      });
    }
  });

  describe("rejects analytical-intent questions", () => {
    const rejects = [
      "why did sales fall in Q3",
      "what's driving the top 10",
      "compare California vs Texas",
      "California versus Texas in revenue",
      "trend of sales over time",
      "sales trends across regions",
      "show me the trend",
      "breakdown of revenue by region",
      "decompose Q3 variance",
      "explain the dip in March",
      "forecast Q4 sales",
      "predict next quarter",
      "what is the correlation between price and units",
      "optimize the marketing spend",
      "redistribute the budget",
      "what if we cut prices 10%",
      "should we invest more in TV",
      "should I drop the SKU",
      "recommend the best channel mix",
      "is there seasonality in sales",
      "what's the attribution by channel",
      "any hypothesis about Q3?",
      "deep dive into category mix",
      "analyze the top 10 brands",
      "root cause of the decline",
    ];
    for (const q of rejects) {
      it(`rejects (analytical): "${q}"`, () => {
        assert.strictEqual(
          detectQuickLookup(q),
          false,
          `Expected "${q}" to NOT fire the fast path`
        );
      });
    }
  });

  describe("rejects multi-part questions", () => {
    const rejects = [
      "top 10 states and why they grew",
      "top 10 states and tell me what drives them",
      "show me top 5 SKUs and explain the gap",
      "highest revenue products and how they trend",
      "latest 5 orders and tell me about delivery times",
      "max margin and what's causing it",
    ];
    for (const q of rejects) {
      it(`rejects (multi-part): "${q}"`, () => {
        assert.strictEqual(
          detectQuickLookup(q),
          false,
          `Expected "${q}" to NOT fire the fast path due to multi-part conjunction`
        );
      });
    }
  });

  it("rejects questions over the length budget", () => {
    const long = "top 10 states by sales " + "x".repeat(140);
    assert.strictEqual(detectQuickLookup(long), false);
  });

  it("rejects empty / non-string input", () => {
    assert.strictEqual(detectQuickLookup(""), false);
    assert.strictEqual(detectQuickLookup("   "), false);
    assert.strictEqual(detectQuickLookup(undefined), false);
    assert.strictEqual(detectQuickLookup(null), false);
  });

  it("rejects shapes that don't match the lookup opener", () => {
    assert.strictEqual(detectQuickLookup("hello"), false);
    assert.strictEqual(
      detectQuickLookup("can you tell me about my data"),
      false
    );
    // "find" is intentionally NOT in the lookup opener — too ambiguous.
    assert.strictEqual(detectQuickLookup("find me the top 10"), false);
  });
});

describe("Wave QL1 · isQuickLookupEnabled", () => {
  it("defaults to true when env unset", () => {
    const prior = process.env.QUICK_LOOKUP_ENABLED;
    delete process.env.QUICK_LOOKUP_ENABLED;
    try {
      assert.strictEqual(isQuickLookupEnabled(), true);
    } finally {
      if (prior !== undefined) process.env.QUICK_LOOKUP_ENABLED = prior;
    }
  });

  it("returns false when explicitly disabled", () => {
    const prior = process.env.QUICK_LOOKUP_ENABLED;
    process.env.QUICK_LOOKUP_ENABLED = "false";
    try {
      assert.strictEqual(isQuickLookupEnabled(), false);
    } finally {
      if (prior !== undefined) process.env.QUICK_LOOKUP_ENABLED = prior;
      else delete process.env.QUICK_LOOKUP_ENABLED;
    }
  });

  it("treats any non-'false' value as enabled", () => {
    const prior = process.env.QUICK_LOOKUP_ENABLED;
    process.env.QUICK_LOOKUP_ENABLED = "true";
    try {
      assert.strictEqual(isQuickLookupEnabled(), true);
    } finally {
      if (prior !== undefined) process.env.QUICK_LOOKUP_ENABLED = prior;
      else delete process.env.QUICK_LOOKUP_ENABLED;
    }
  });
});
