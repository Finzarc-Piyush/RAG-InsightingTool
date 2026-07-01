import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectComputedRelationIntent } from "../lib/agents/runtime/planArgRepairs.js";

/**
 * W-FAIL3 · The quick-lookup fast path can't express `computedAggregations`, so
 * "gap/difference/ratio between two measures" questions always waste a Mini
 * draft then fall back. This guard routes them straight to the full loop.
 */
describe("W-FAIL3 detectComputedRelationIntent", () => {
  it("flags gap/difference/ratio/subtraction questions (route to full loop)", () => {
    const yes = [
      "Which brand code has the largest gap between MRP Value and NR?",
      "What is the difference between MRP Value and NR by brand?",
      "Show the spread between list price and net price",
      "ratio of GST to Net Sales by channel",
      "ratio between MRP and NR",
      "NR minus GST for each SKU",
      "Net Sales net of returns by region",
    ];
    for (const q of yes) assert.equal(detectComputedRelationIntent(q), true, q);
  });

  it("does NOT flag plain lookups or groupable comparisons (stay on fast path)", () => {
    const no = [
      "Which brand has the highest NR in Apr 26?",
      "Top 10 SKUs by sales",
      "How many regions are there?",
      "GT vs Q-com sales by month", // groupable comparison, not a computed field
      "Compare sales across channels",
      "",
      undefined,
    ];
    for (const q of no) assert.equal(detectComputedRelationIntent(q), false, String(q));
  });
});
