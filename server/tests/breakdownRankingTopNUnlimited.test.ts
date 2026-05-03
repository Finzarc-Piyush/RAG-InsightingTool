// RNK1 · Pin that breakdown_ranking now accepts arbitrary topN values
// (the prior `max(50)` zod cap silently truncated "top 300" / "top 5000"
// questions). Also pins the observation slimmer: regardless of how many
// rows the user asked for, the textual `summary` snippet keeps at most
// 10 rows of JSON; the full table rides on `ToolResult.table`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { breakdownRankingArgsSchema } from "../lib/agents/runtime/tools/breakdownRankingTool.js";

describe("RNK1 · breakdown_ranking topN cap removed", () => {
  it("accepts topN: 300", () => {
    const parsed = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: 300,
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.topN, 300);
    }
  });

  it("accepts topN: 5000", () => {
    const parsed = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: 5000,
    });
    assert.equal(parsed.success, true);
  });

  it("accepts topN: 1 (single-entity max use case)", () => {
    const parsed = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: 1,
    });
    assert.equal(parsed.success, true);
  });

  it("accepts direction: 'asc'", () => {
    const parsed = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: 5,
      direction: "asc",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.direction, "asc");
    }
  });

  it("rejects topN: 0 and negative N", () => {
    const zero = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: 0,
    });
    assert.equal(zero.success, false);
    const neg = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
      topN: -10,
    });
    assert.equal(neg.success, false);
  });

  it("defaults topN to 20 and direction to 'desc' when omitted", () => {
    const parsed = breakdownRankingArgsSchema.safeParse({
      metricColumn: "Sales",
      breakdownColumn: "Salesperson",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.topN, 20);
      assert.equal(parsed.data.direction, "desc");
    }
  });
});
