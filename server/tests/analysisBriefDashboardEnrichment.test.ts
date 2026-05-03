import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test__ } from "../lib/agents/runtime/analysisBrief.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

const { columnListForBrief, describeColumnForBrief, looksLikeDashboardOrReport } = __test__;

/**
 * DB2 · The brief LLM drives candidateDriverDimensions, which drives the
 * planner's chart fan-out and the deterministic feature sweep. Pre-DB2 the
 * brief saw only column names; for dashboard-shaped intent we now emit a
 * metadata table (cardinality + examples) so dimension selection is grounded
 * in actual data shape.
 */

const numericSet = new Set(["Sales"]);
const dateSet = new Set(["Order Date"]);

function makeCtx(overrides: { question?: string; cols?: any[] } = {}): AgentExecutionContext {
  const cols = overrides.cols ?? [
    {
      name: "Region",
      type: "string",
      sampleValues: ["West"],
      topValues: [
        { value: "West", count: 100 },
        { value: "East", count: 80 },
        { value: "Central", count: 70 },
        { value: "South", count: 60 },
      ],
    },
    { name: "Sales", type: "number", sampleValues: [10, 100] },
    { name: "Order Date", type: "date", sampleValues: ["2018-01-01", "2020-12-31"] },
  ];
  return {
    question: overrides.question ?? "summarise the data",
    summary: {
      rowCount: 100,
      columnCount: cols.length,
      columns: cols,
      numericColumns: cols.filter((c) => c.type === "number").map((c) => c.name),
      dateColumns: cols.filter((c) => c.type === "date").map((c) => c.name),
    },
  } as unknown as AgentExecutionContext;
}

describe("looksLikeDashboardOrReport", () => {
  it("matches explicit dashboard asks", () => {
    assert.strictEqual(looksLikeDashboardOrReport("build me a sales dashboard"), true);
    assert.strictEqual(looksLikeDashboardOrReport("create a monitoring view"), true);
    assert.strictEqual(looksLikeDashboardOrReport("turn this into a report"), true);
  });
  it("does not match plain analytical questions", () => {
    assert.strictEqual(looksLikeDashboardOrReport("what are sales by region?"), false);
    assert.strictEqual(looksLikeDashboardOrReport("which product sells the most"), false);
  });
});

describe("describeColumnForBrief", () => {
  it("emits cardinality + top values for low-cardinality categoricals", () => {
    const out = describeColumnForBrief(
      {
        name: "Region",
        type: "string",
        sampleValues: ["West"],
        topValues: [
          { value: "West", count: 100 },
          { value: "East", count: 80 },
          { value: "Central", count: 70 },
          { value: "South", count: 60 },
        ],
      },
      numericSet,
      dateSet
    );
    assert.match(out, /^Region \| string \| distinct≈4 \| top=\[West\|East\|Central\]$/);
  });
  it("emits distinct≥48 for saturated topValues lists", () => {
    const topValues = Array.from({ length: 48 }, (_, i) => ({ value: `v${i}`, count: 100 }));
    const out = describeColumnForBrief(
      { name: "ProductSKU", type: "string", sampleValues: ["v0"], topValues },
      numericSet,
      dateSet
    );
    assert.ok(out.includes("distinct≥48"));
  });
  it("collapses numeric and date columns to bare type", () => {
    const num = describeColumnForBrief(
      { name: "Sales", type: "number", sampleValues: [1, 2] },
      numericSet,
      dateSet
    );
    assert.strictEqual(num, "Sales | number");
    const dt = describeColumnForBrief(
      { name: "Order Date", type: "date", sampleValues: ["2020-01-01"] },
      numericSet,
      dateSet
    );
    assert.strictEqual(dt, "Order Date | date");
  });
});

describe("columnListForBrief", () => {
  it("emits a comma-separated name list for non-dashboard intent", () => {
    const ctx = makeCtx({ question: "what are sales by region?" });
    const out = columnListForBrief(ctx);
    assert.strictEqual(out, "Region, Sales, Order Date");
  });

  it("emits a structured metadata table for dashboard intent", () => {
    const ctx = makeCtx({ question: "build me a sales dashboard" });
    const out = columnListForBrief(ctx);
    assert.ok(out.startsWith("(format: name | type | cardinality-hint | top-values)"));
    assert.ok(out.includes("- Region | string | distinct≈4 | top=[West|East|Central]"));
    assert.ok(out.includes("- Sales | number"));
    assert.ok(out.includes("- Order Date | date"));
  });

  it("caps the dashboard table at 200 columns and notes truncation", () => {
    const cols = Array.from({ length: 250 }, (_, i) => ({
      name: `c${i}`,
      type: "string",
      sampleValues: [],
      topValues: [{ value: "x", count: 1 }],
    }));
    const ctx = makeCtx({ question: "make me a dashboard for X", cols });
    const out = columnListForBrief(ctx);
    assert.ok(out.includes("(truncated · showing first 200 of 250 columns)"));
    assert.ok(out.includes("- c199 |"));
    assert.ok(!out.includes("- c200 |"));
  });

  it("uses the 120-column cap for the legacy non-dashboard path", () => {
    const cols = Array.from({ length: 200 }, (_, i) => ({
      name: `c${i}`,
      type: "string",
      sampleValues: [],
      topValues: [{ value: "x", count: 1 }],
    }));
    const ctx = makeCtx({ question: "what's the average?", cols });
    const out = columnListForBrief(ctx);
    const names = out.split(", ");
    assert.strictEqual(names.length, 120);
    assert.strictEqual(names[0], "c0");
    assert.strictEqual(names[119], "c119");
  });
});
