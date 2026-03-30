import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeContextForPrompt } from "../lib/agents/runtime/context.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";
import { executeQueryPlan } from "../lib/queryPlanExecutor.js";

describe("summarizeContextForPrompt", () => {
  it("includes dateColumns and numericColumns lines for the planner", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 3,
      columns: [
        { name: "Order Date", type: "date", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [10] },
        { name: "Region", type: "string", sampleValues: ["West"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    const ctx = {
      sessionId: "s1",
      question: "q",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /dateColumns:\s*Order Date/);
    assert.match(text, /numericColumns:\s*Sales/);
    assert.match(text, /columns:\s*Order Date, Sales, Region/);
  });
});

describe("execute_query_plan temporal aggregation", () => {
  it("buckets by month with dateAggregationPeriod and sums Sales", () => {
    const summary: DataSummary = {
      rowCount: 3,
      columnCount: 2,
      columns: [
        { name: "Order Date", type: "date", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [100] },
      ],
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    const data = [
      { "Order Date": new Date(2024, 0, 5), Sales: 100 },
      { "Order Date": new Date(2024, 0, 20), Sales: 50 },
      { "Order Date": new Date(2024, 1, 1), Sales: 200 },
    ];
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum", alias: "total_sales" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.data.length, 2);
    const totals = out.data.map((r) => r.total_sales as number).sort((a, b) => a - b);
    assert.deepEqual(totals, [150, 200]);
  });
});
