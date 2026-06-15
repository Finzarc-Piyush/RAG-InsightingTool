/**
 * Golden-replay coverage for the visual-planner deterministic fallback after it
 * was merged onto `buildChartFromAnalyticalTable` (the chart-promotion builder).
 *
 * The fallback no longer re-implements the column-split → x-pick → measure-pick →
 * type → compile → finish flow inline; it delegates to the ONE builder and then
 * re-applies the ctx-aware `validateChartProposal` guard. These tests pin:
 *   1. the success cases still produce the expected chart + deterministic note,
 *   2. the bail-out cases return null (so the caller falls through to the LLM),
 *   3. EQUIVALENCE — the fallback's chart is byte-identical to what
 *      `buildChartFromAnalyticalTable` returns for the same table. This is the
 *      drift tripwire: if a future edit re-introduces bespoke fallback logic, the
 *      two outputs diverge and this test fails.
 *
 * Documented behavior deltas vs the pre-merge inline fallback (intentional —
 * this wave's deliberate decision; see docs/decisions/duplication-audit-deferrals.md):
 *   - a 1-row scalar frame now returns null (chartFromTable's scalar guard) —
 *     was: usually hit the no-usable-dim path anyway,
 *   - a no-usable-dim frame returns null → caller falls through to the LLM —
 *     was: an early `return {charts:[]}` that short-circuited the LLM (the
 *     in-code comment already said it SHOULD fall through),
 *   - a compile/parse throw is caught → null — was: an uncaught throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicFallbackChart } from "../lib/agents/runtime/visualPlanner.js";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { ChartSpec, DataSummary } from "../shared/schema.js";

function makeSummary(
  columns: string[],
  opts: { numericColumns?: string[]; dateColumns?: string[] } = {}
): DataSummary {
  const numericColumns = opts.numericColumns ?? [];
  const dateColumns = opts.dateColumns ?? [];
  return {
    rowCount: 1000,
    columnCount: columns.length,
    columns: columns.map((name) => ({
      name,
      type: numericColumns.includes(name)
        ? "number"
        : dateColumns.includes(name)
          ? "date"
          : "string",
      sampleValues: [],
    })),
    numericColumns,
    dateColumns,
    categoricalColumns: columns.filter(
      (c) => !numericColumns.includes(c) && !dateColumns.includes(c)
    ),
    sampleRows: [],
  } as unknown as DataSummary;
}

function makeCtx(
  table: { rows: Record<string, unknown>[]; columns: string[] },
  opts: {
    numericColumns?: string[];
    dateColumns?: string[];
    question?: string;
  } = {}
): AgentExecutionContext {
  return {
    sessionId: "s",
    question: opts.question ?? "?",
    data: table.rows,
    turnStartDataRef: table.rows,
    summary: makeSummary(table.columns, opts),
    chatHistory: [],
    mode: "analysis",
    lastAnalyticalTable: { columns: table.columns, rows: table.rows },
  } as unknown as AgentExecutionContext;
}

test("fallback: categorical X + numeric Y → bar chart + deterministic note", () => {
  const table = {
    rows: [
      { Category: "Technology", Sales_sum: 827_455 },
      { Category: "Furniture", Sales_sum: 728_658 },
      { Category: "Office Supplies", Sales_sum: 705_415 },
    ],
    columns: ["Category", "Sales_sum"],
  };
  const ctx = makeCtx(table, {
    numericColumns: ["Sales_sum"],
    question: "which category did great",
  });
  const out = buildDeterministicFallbackChart(ctx, []);
  assert.notEqual(out, null);
  assert.equal(out!.charts.length, 1);
  assert.equal(out!.charts[0].type, "bar");
  assert.equal(out!.charts[0].x, "Category");
  assert.equal(out!.charts[0].y, "Sales_sum");
  assert.equal(
    out!.note,
    `Deterministic chart fallback for breakdown: ${out!.charts[0].title}`
  );
});

test("fallback: temporal X (date column) → chart preserving Order_Date axis", () => {
  const table = {
    rows: [
      { Order_Date: "2015-01-01", Sales_sum: 480_000 },
      { Order_Date: "2016-01-01", Sales_sum: 460_000 },
      { Order_Date: "2017-01-01", Sales_sum: 600_000 },
      { Order_Date: "2018-01-01", Sales_sum: 720_000 },
    ],
    columns: ["Order_Date", "Sales_sum"],
  };
  const ctx = makeCtx(table, {
    numericColumns: ["Sales_sum"],
    dateColumns: ["Order_Date"],
    question: "yearly sales trend",
  });
  const out = buildDeterministicFallbackChart(ctx, []);
  assert.notEqual(out, null);
  assert.equal(out!.charts[0].x, "Order_Date");
  assert.equal(out!.charts[0].y, "Sales_sum");
});

test("fallback: boolean-indicator rate breakdown charts the rate, not matching/total", () => {
  const table = {
    rows: [
      { "Cluster Name": "North", matching: 70, total: 90, "PJP Adherence_rate": 0.78 },
      { "Cluster Name": "South", matching: 40, total: 100, "PJP Adherence_rate": 0.4 },
      { "Cluster Name": "West", matching: 55, total: 70, "PJP Adherence_rate": 0.79 },
    ],
    columns: ["Cluster Name", "matching", "total", "PJP Adherence_rate"],
  };
  const ctx = makeCtx(table, {
    numericColumns: ["matching", "total", "PJP Adherence_rate"],
    question: "pjp adherence by cluster",
  });
  const out = buildDeterministicFallbackChart(ctx, []);
  assert.notEqual(out, null);
  assert.equal(out!.charts[0].x, "Cluster Name");
  assert.equal(out!.charts[0].y, "PJP Adherence_rate");
});

test("fallback: returns null when existing charts already present", () => {
  const table = {
    rows: [
      { Category: "A", Sales_sum: 5 },
      { Category: "B", Sales_sum: 9 },
    ],
    columns: ["Category", "Sales_sum"],
  };
  const ctx = makeCtx(table, { numericColumns: ["Sales_sum"] });
  const existing = [{ type: "bar", title: "x", x: "Category", y: "Sales_sum" } as ChartSpec];
  assert.equal(buildDeterministicFallbackChart(ctx, existing), null);
});

test("fallback: returns null when no analytical table", () => {
  const ctx = {
    sessionId: "s",
    question: "?",
    data: [],
    summary: makeSummary([]),
    chatHistory: [],
    mode: "analysis",
  } as unknown as AgentExecutionContext;
  assert.equal(buildDeterministicFallbackChart(ctx, []), null);
});

test("fallback: single-value dimension → null (no usable dim → fall through to LLM)", () => {
  const table = {
    rows: [
      { Product: "MARICO", Sales_sum: 100 },
      { Product: "MARICO", Sales_sum: 240 },
    ],
    columns: ["Product", "Sales_sum"],
  };
  const ctx = makeCtx(table, { numericColumns: ["Sales_sum"] });
  assert.equal(buildDeterministicFallbackChart(ctx, []), null);
});

test("fallback: scalar (1-row) frame → null (delegated scalar guard)", () => {
  const table = {
    rows: [{ Category: "A", Sales_sum: 100 }],
    columns: ["Category", "Sales_sum"],
  };
  const ctx = makeCtx(table, { numericColumns: ["Sales_sum"] });
  assert.equal(buildDeterministicFallbackChart(ctx, []), null);
});

test("fallback: X cardinality > 60 → null (fall through to LLM)", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({
    label: `item_${i}`,
    val: i,
  }));
  const ctx = makeCtx({ rows, columns: ["label", "val"] }, {
    numericColumns: ["val"],
  });
  assert.equal(buildDeterministicFallbackChart(ctx, []), null);
});

test("fallback: row count > 200 → null", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    Cat: `c_${i % 5}`,
    val: i,
  }));
  const ctx = makeCtx({ rows, columns: ["Cat", "val"] }, {
    numericColumns: ["val"],
  });
  assert.equal(buildDeterministicFallbackChart(ctx, []), null);
});

test("EQUIVALENCE: fallback chart === buildChartFromAnalyticalTable for the same table (categorical)", () => {
  const table = {
    rows: [
      { Region: "North", revenue_sum: 1200 },
      { Region: "South", revenue_sum: 800 },
      { Region: "West", revenue_sum: 1500 },
    ],
    columns: ["Region", "revenue_sum"],
  };
  const summary = makeSummary(table.columns, { numericColumns: ["revenue_sum"] });
  const direct = buildChartFromAnalyticalTable({
    table,
    summary,
    question: "revenue by region",
  });
  const ctx = makeCtx(table, {
    numericColumns: ["revenue_sum"],
    question: "revenue by region",
  });
  const fallback = buildDeterministicFallbackChart(ctx, []);
  assert.notEqual(direct, null);
  assert.notEqual(fallback, null);
  // The fallback's single chart must be byte-identical to the promotion builder's
  // output — they now call the same code, so any divergence is a regression.
  assert.deepEqual(fallback!.charts[0], direct);
});

test("EQUIVALENCE: fallback chart === buildChartFromAnalyticalTable (BIR rate frame)", () => {
  const table = {
    rows: [
      { Region: "East", adherence__matching: 70, adherence__total: 90, adherence_rate: 0.78 },
      { Region: "West", adherence__matching: 40, adherence__total: 100, adherence_rate: 0.4 },
      { Region: "South", adherence__matching: 55, adherence__total: 70, adherence_rate: 0.79 },
    ],
    columns: ["Region", "adherence__matching", "adherence__total", "adherence_rate"],
  };
  const summary = makeSummary(table.columns, {
    numericColumns: ["adherence__matching", "adherence__total", "adherence_rate"],
  });
  const direct = buildChartFromAnalyticalTable({ table, summary, question: "?" });
  const ctx = makeCtx(table, {
    numericColumns: ["adherence__matching", "adherence__total", "adherence_rate"],
  });
  const fallback = buildDeterministicFallbackChart(ctx, []);
  assert.notEqual(direct, null);
  assert.deepEqual(fallback!.charts[0], direct);
});
