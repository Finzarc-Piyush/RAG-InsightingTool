import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartSpecSchema } from "../shared/schema.js";

/**
 * W7.2 · Pin the provenance field shape on `ChartSpec`. UI components +
 * downstream "where did this come from" popovers depend on this schema. A
 * regression that drops the optional `_agentProvenance` field would silently
 * break those features without a runtime crash.
 */

describe("chartSpecSchema · W7.2 _agentProvenance", () => {
  const validBase = {
    type: "bar" as const,
    title: "Sales by region",
    x: "region",
    y: "sales",
  };

  it("accepts a chart without provenance (backward compat)", () => {
    const r = chartSpecSchema.safeParse(validBase);
    assert.strictEqual(r.success, true);
  });

  it("accepts a chart with a single tool call provenance entry", () => {
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: {
        toolCalls: [{ id: "call_1", tool: "execute_query_plan" }],
      },
    });
    assert.strictEqual(r.success, true);
  });

  it("accepts row counts on a tool call", () => {
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: {
        toolCalls: [
          {
            id: "call_1",
            tool: "execute_query_plan",
            rowsIn: 9800,
            rowsOut: 12,
          },
        ],
      },
    });
    assert.strictEqual(r.success, true);
  });

  it("accepts an optional sqlEquivalent + sources list", () => {
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: {
        toolCalls: [{ id: "call_1", tool: "execute_query_plan" }],
        sqlEquivalent: "SELECT region, SUM(sales) FROM data GROUP BY region",
        sources: ["dataset.train.xlsx"],
      },
    });
    assert.strictEqual(r.success, true);
  });

  it("rejects negative row counts", () => {
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: {
        toolCalls: [{ id: "call_1", tool: "x", rowsIn: -1 }],
      },
    });
    assert.strictEqual(r.success, false);
  });

  it("rejects more than 8 tool calls (cap to keep payloads light)", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      id: `call_${i}`,
      tool: "execute_query_plan",
    }));
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: { toolCalls: tooMany },
    });
    assert.strictEqual(r.success, false);
  });

  it("rejects an oversized sqlEquivalent (>2000 chars)", () => {
    const r = chartSpecSchema.safeParse({
      ...validBase,
      _agentProvenance: {
        toolCalls: [{ id: "call_1", tool: "x" }],
        sqlEquivalent: "x".repeat(2001),
      },
    });
    assert.strictEqual(r.success, false);
  });
});
