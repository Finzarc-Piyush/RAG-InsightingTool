/**
 * queryIntentAuthority — the single source of truth for question intent.
 *
 * Pins the depthBudget policy (minimal for plain lookups / direct factual asks,
 * full for diagnostic / strategic, standard otherwise) and the classifier
 * contracts that isDirectFactualQuestion + detectQuickLookup now delegate to.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQueryIntent,
  isMinimalDepth,
} from "../lib/agents/runtime/queryIntentAuthority.js";

describe("queryIntentAuthority · classifyQueryIntent", () => {
  it("direct factual asks → minimal depth, isDirectFactual", () => {
    const cases = [
      "What is the average number of compliance visits per cluster?",
      "Which TSOE has the highest GCPC?",
      "How many TSOEs have not uploaded the PJP yet?",
      "List the clusters by ASM count",
      "Show me the top 5 by compliance visits",
      "Tell me the average for each region",
      "Name the cluster with the most non-compliance visits",
    ];
    for (const q of cases) {
      const r = classifyQueryIntent(q);
      assert.equal(r.isDirectFactual, true, `isDirectFactual: ${q}`);
      assert.equal(r.depthBudget, "minimal", `minimal: ${q}`);
    }
  });

  it("lookup-shaped asks → minimal depth, isLookupShape", () => {
    const cases = [
      "top 10 states by sales",
      "highest revenue products",
      "lowest margin SKUs",
      "how many orders last month",
      "count of unique customers",
      "average price by category",
      "latest 5 orders",
      "Which 10 states sold the most?",
    ];
    for (const q of cases) {
      const r = classifyQueryIntent(q);
      assert.equal(r.isLookupShape, true, `isLookupShape: ${q}`);
      assert.equal(r.depthBudget, "minimal", `minimal: ${q}`);
    }
  });

  it("diagnostic asks → full depth", () => {
    const cases = [
      "Why did sales drop last quarter?",
      "What's driving the increase in compliance visits?",
      "Decompose the variance in GCPC adherence",
      "Investigate the root cause of low adherence",
      "Which drivers explain the variance?",
    ];
    for (const q of cases) {
      const r = classifyQueryIntent(q);
      assert.equal(r.depthBudget, "full", `full: ${q}`);
      assert.equal(r.isDirectFactual, false, `not factual: ${q}`);
    }
  });

  it("strategic asks → full depth", () => {
    const cases = [
      "How can I improve PJP adherence in Cluster 1 EAST?",
      "What if we increased compliance visits by 20%?",
      "How do I rescue falling sales?",
      "recommend the best channel mix",
      "should we invest more in TV",
      "optimize the marketing spend",
    ];
    for (const q of cases) {
      assert.equal(classifyQueryIntent(q).depthBudget, "full", `full: ${q}`);
    }
  });

  it("descriptive (comparison / trend) asks → standard depth (no over-strip, no force-expand)", () => {
    const cases = [
      "Compare Cluster 1 EAST vs Cluster 2 SOUTH on compliance visits",
      "What is the trend in compliance visits over time?",
      "sales trends across regions",
      "breakdown of revenue by region",
    ];
    for (const q of cases) {
      const r = classifyQueryIntent(q);
      assert.equal(r.depthBudget, "standard", `standard: ${q}`);
      assert.equal(r.isDirectFactual, false, `not factual: ${q}`);
    }
  });

  it("multi-part lookups are NOT minimal (the tail demands analysis)", () => {
    const r = classifyQueryIntent("top 10 states and why they grew");
    assert.equal(r.isLookupShape, false);
    assert.notEqual(r.depthBudget, "minimal");
  });

  it("edge cases are safe and never minimal-by-accident", () => {
    for (const q of ["", "   ", "?", "hi"]) {
      const r = classifyQueryIntent(q);
      assert.equal(r.isDirectFactual, false, `not factual: "${q}"`);
      assert.equal(r.isLookupShape, false, `not lookup: "${q}"`);
    }
    assert.equal(classifyQueryIntent(undefined).depthBudget !== "minimal", true);
    assert.equal(classifyQueryIntent(null).isDirectFactual, false);
  });

  it("isMinimalDepth convenience matches depthBudget", () => {
    assert.equal(isMinimalDepth("top 10 states by sales"), true);
    assert.equal(isMinimalDepth("why did sales fall"), false);
    assert.equal(isMinimalDepth("compare A vs B"), false);
  });
});
