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

  it("includes AUTHORITATIVE columns when streamPreAnalysis provides canonicalColumns", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Product Category", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [1] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const ctx = {
      sessionId: "s1",
      question: "Which categories have highest sales?",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
      streamPreAnalysis: {
        intentLabel: "compare",
        analysis: "",
        relevantColumns: ["Product Category", "Sales"],
        userIntent: "rank categories",
        canonicalColumns: ["Product Category", "Sales"],
        columnMapping: { categories: "Product Category" },
      },
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /AUTHORITATIVE columns for this question/);
    assert.match(text, /Product Category, Sales/);
    assert.match(text, /Phrase → column:/);
  });

  it("includes DIAGNOSTIC_ANALYSIS_HINT when analysisSpec.mode is diagnostic", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [1] },
        { name: "Region", type: "string", sampleValues: ["East"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const ctx = {
      sessionId: "s1",
      question: "Investigating factors driving Technology success in the East",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
      analysisSpec: { mode: "diagnostic" as const, outcomeColumn: "Sales" },
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /DIAGNOSTIC_ANALYSIS_HINT/);
    assert.match(text, /Sales/);
  });

  it("includes categoricalValues block when columns have topValues", () => {
    const summary: DataSummary = {
      rowCount: 100,
      columnCount: 3,
      columns: [
        { name: "Sales", type: "number", sampleValues: [1] },
        {
          name: "Category",
          type: "string",
          sampleValues: [],
          topValues: [
            { value: "Furniture", count: 30 },
            { value: "Office Supplies", count: 50 },
            { value: "Technology", count: 20 },
          ],
        },
        { name: "Note", type: "string", sampleValues: ["x"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
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
    assert.match(text, /categoricalValues/);
    assert.match(text, /Category=\[Furniture\|Office Supplies\|Technology\]/);
    assert.doesNotMatch(text, /Sales=\[/);
    assert.doesNotMatch(text, /Note=\[/);
  });

  it("omits the categoricalValues block when no column has topValues", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [1] },
        { name: "Note", type: "string", sampleValues: ["x"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
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
    assert.doesNotMatch(text, /categoricalValues/);
  });

  it("caps each categorical column to 8 topValues", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i.toString().padStart(2, "0")}`,
      count: 20 - i,
    }));
    const summary: DataSummary = {
      rowCount: 100,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Big", type: "string", sampleValues: [], topValues: many },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
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
    const m = text.match(/Big=\[([^\]]+)\]/);
    assert.ok(m, "expected Big=[...]");
    const vals = m![1]!.split("|");
    assert.equal(vals.length, 8);
    assert.deepEqual(vals, ["v00", "v01", "v02", "v03", "v04", "v05", "v06", "v07"]);
  });

  it("includes ANALYSIS_BRIEF_JSON when ctx.analysisBrief is set", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [1] },
        { name: "Region", type: "string", sampleValues: ["East"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const ctx = {
      sessionId: "s1",
      question: "Why did sales fall?",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
      analysisBrief: {
        version: 1 as const,
        outcomeMetricColumn: "Sales",
        clarifyingQuestions: [],
        epistemicNotes: ["Avoid causal claims."],
      },
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /ANALYSIS_BRIEF_JSON/);
    assert.match(text, /Avoid causal claims/);
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
