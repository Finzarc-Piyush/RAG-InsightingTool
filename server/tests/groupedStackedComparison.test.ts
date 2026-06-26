/**
 * Wave 4 — grouped / stacked comparison charts.
 *
 * (a) chartSpecCompiler defaults a multi-series bar to GROUPED for non-additive
 *     measures (rates / %/ score / per-record mean) and STACKED for additive
 *     ones — an explicit barLayout always wins.
 * (b) buildAnchorComparisonCharts emits "anchor vs named-secondary by dim"
 *     grouped tiles ONLY when the brief carries outline metrics (the user named
 *     a partner), never for a pointed single-metric ask.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileChartSpec } from "../lib/chartSpecCompiler.js";
import { buildAnchorComparisonCharts } from "../lib/agents/runtime/metricComparisonCharts.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

describe("chartSpecCompiler · grouped-vs-stacked default", () => {
  const summary = { numericColumns: ["Adherence Rate", "Units"], dateColumns: [] };

  it("defaults a rate-named multi-series bar to GROUPED", () => {
    const rows = [
      { Region: "West", Channel: "GT", "Adherence Rate": 0.8 },
      { Region: "West", Channel: "MT", "Adherence Rate": 0.6 },
      { Region: "East", Channel: "GT", "Adherence Rate": 0.7 },
    ];
    const { merged } = compileChartSpec(rows, summary, {
      type: "bar",
      x: "Region",
      y: "Adherence Rate",
    });
    assert.strictEqual(merged.seriesColumn, "Channel");
    assert.strictEqual(merged.barLayout, "grouped");
  });

  it("defaults an additive (sum) multi-series bar to STACKED", () => {
    const rows = [
      { Region: "West", Channel: "GT", Units: 100 },
      { Region: "West", Channel: "MT", Units: 50 },
      { Region: "East", Channel: "GT", Units: 80 },
    ];
    const { merged } = compileChartSpec(rows, summary, {
      type: "bar",
      x: "Region",
      y: "Units",
    });
    assert.strictEqual(merged.barLayout, "stacked");
  });

  it("honours an explicit barLayout over the default", () => {
    const rows = [
      { Region: "West", Channel: "GT", Units: 100 },
      { Region: "West", Channel: "MT", Units: 50 },
    ];
    const { merged } = compileChartSpec(rows, summary, {
      type: "bar",
      x: "Region",
      y: "Units",
      barLayout: "grouped",
    });
    assert.strictEqual(merged.barLayout, "grouped");
  });
});

// ── buildAnchorComparisonCharts ─────────────────────────────────────────────

function ind(name: string, pos: string, neg: string): DataSummary["columns"][number] {
  return {
    name,
    type: "string",
    sampleValues: [pos],
    indicator: { kind: "boolean", positiveValues: [pos], negativeValues: [neg], sentinelValues: [], source: "auto" },
  } as DataSummary["columns"][number];
}

function summaryWith(): DataSummary {
  return {
    rowCount: 4,
    columnCount: 3,
    columns: [
      { name: "Region", type: "string", sampleValues: ["West"] },
      ind("PJP Adherence", "Yes", "No"),
      ind("Attendance Status", "Present", "Absent"),
    ],
    numericColumns: [],
    dateColumns: [],
  } as unknown as DataSummary;
}

const ROWS = [
  { Region: "West", "PJP Adherence": "Yes", "Attendance Status": "Present" },
  { Region: "West", "PJP Adherence": "No", "Attendance Status": "Present" },
  { Region: "East", "PJP Adherence": "Yes", "Attendance Status": "Absent" },
  { Region: "East", "PJP Adherence": "Yes", "Attendance Status": "Present" },
];

function ctxWith(brief: Partial<AnalysisBrief>): AgentExecutionContext {
  return {
    question: "build a PJP dashboard",
    summary: summaryWith(),
    data: ROWS,
    turnStartDataRef: ROWS,
    depthBudget: "full",
    analysisBrief: { requestsDashboard: true, ...brief } as AnalysisBrief,
  } as unknown as AgentExecutionContext;
}

describe("buildAnchorComparisonCharts", () => {
  it("builds a grouped PJP-vs-Attendance tile when a partner was named", () => {
    const ctx = ctxWith({
      outcomeMetricColumn: "PJP Adherence",
      outlineMetrics: ["Attendance Status"],
      segmentationDimensions: ["Region"],
    });
    const charts = buildAnchorComparisonCharts(ctx);
    assert.strictEqual(charts.length, 1);
    const c = charts[0]!;
    assert.strictEqual(c.barLayout, "grouped");
    assert.strictEqual(c.seriesColumn, "Metric");
    assert.strictEqual(c.x, "Region");
    assert.match(c.title, /PJP Adherence vs Attendance Status by Region/);
  });

  it("produces nothing for a pointed single-metric dashboard (no outline metrics)", () => {
    const ctx = ctxWith({
      outcomeMetricColumn: "PJP Adherence",
      segmentationDimensions: ["Region"],
    });
    assert.deepStrictEqual(buildAnchorComparisonCharts(ctx), []);
  });

  it("produces nothing without a key dimension to compare across", () => {
    const ctx = ctxWith({
      outcomeMetricColumn: "PJP Adherence",
      outlineMetrics: ["Attendance Status"],
      segmentationDimensions: [],
    });
    assert.deepStrictEqual(buildAnchorComparisonCharts(ctx), []);
  });
});
