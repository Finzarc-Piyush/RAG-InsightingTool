import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartSpecSchema } from "../shared/schema.js";

/**
 * W12 · per-chart `businessCommentary` schema contract.
 *
 * The runtime path (LLM call) is exercised in end-to-end smoke tests only —
 * it requires Azure OpenAI credentials and stubbing it would defeat the
 * purpose. This test pins the persisted shape so chart renderers and chart
 * persistence (Cosmos) stay in sync, and confirms back-compat with charts
 * that pre-date W12.
 */
describe("W12 · chartSpecSchema.businessCommentary", () => {
  const baseChart = {
    type: "bar" as const,
    title: "Saffola Volume_MT by Region — Q3",
    x: "Region",
    y: "Volume_MT",
  };

  it("accepts a chart with a populated businessCommentary citing a pack id", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart,
      keyInsight: "South leads at 412 MT; East trails at 84 MT.",
      businessCommentary:
        "Per `kpi-and-metric-glossary`, Volume_MT is the primary in-market trade indicator and a regional skew of this magnitude usually flags distribution-driven imbalance rather than demand softness.",
    });
    assert.match(parsed.businessCommentary!, /kpi-and-metric-glossary/);
  });

  it("accepts a chart with no businessCommentary (back-compat)", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart,
      keyInsight: "South leads at 412 MT.",
    });
    assert.equal(parsed.businessCommentary, undefined);
  });

  it("rejects a businessCommentary over 500 chars", () => {
    assert.throws(() =>
      chartSpecSchema.parse({
        ...baseChart,
        businessCommentary: "x".repeat(501),
      })
    );
  });

  it("preserves businessCommentary alongside other optional metadata", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart,
      keyInsight: "ki",
      businessCommentary: "bc",
      _agentTurnId: "t-1",
      _agentEvidenceRef: "tool:execute_query_plan:1",
    });
    assert.equal(parsed.keyInsight, "ki");
    assert.equal(parsed.businessCommentary, "bc");
    assert.equal(parsed._agentTurnId, "t-1");
  });
});
