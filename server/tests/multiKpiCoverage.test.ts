/**
 * Wave W6 · multi-KPI dashboard.
 *
 * (a) ensureDashboardOutlineMetrics seeds `outlineMetrics` with the dataset's
 *     OTHER boolean indicators when the outcome is itself a boolean indicator
 *     (indicator-centric "PJP dashboard") — and is a no-op for numeric outcomes.
 * (b) assertDashboardCoverage charts each secondary KPI by the key low-card
 *     dimensions (bounded), so the board is multi-KPI rather than single-metric.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertDashboardCoverage } from "../lib/agents/runtime/dashboardCoverageGate.js";
import { ensureDashboardOutlineMetrics } from "../lib/agents/runtime/analysisBrief.js";
import type { PlanStep, AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

function indicatorCol(
  name: string,
  positive: string,
  negative: string
): DataSummary["columns"][number] {
  return {
    name,
    type: "string",
    sampleValues: [positive],
    topValues: [
      { value: positive, count: 70 },
      { value: negative, count: 30 },
    ],
    indicator: {
      kind: "boolean",
      positiveValues: [positive],
      negativeValues: [negative],
      sentinelValues: [],
      source: "auto",
    },
  } as DataSummary["columns"][number];
}

function multiKpiSummary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 6,
    columns: [
      {
        name: "Region",
        type: "string",
        sampleValues: ["West"],
        topValues: [
          { value: "West", count: 50 },
          { value: "East", count: 50 },
        ],
      },
      {
        name: "Category",
        type: "string",
        sampleValues: ["A"],
        topValues: [
          { value: "A", count: 60 },
          { value: "B", count: 40 },
        ],
      },
      indicatorCol("PJP Adherence", "Yes", "No"),
      indicatorCol("Attendance Status", "Present", "Absent"),
      indicatorCol("Clock-In <09:30", "Yes", "No"),
      { name: "Sales", type: "number", sampleValues: [1, 2] },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  };
}

function ctxOf(summary: DataSummary, brief: Partial<AnalysisBrief>): AgentExecutionContext {
  return { summary, analysisBrief: brief as AnalysisBrief } as AgentExecutionContext;
}

describe("W6 · ensureDashboardOutlineMetrics", () => {
  it("seeds outlineMetrics with the OTHER boolean indicators for an indicator outcome", () => {
    const summary = multiKpiSummary();
    const brief = ensureDashboardOutlineMetrics(
      { version: 1, requestsDashboard: true, outcomeMetricColumn: "PJP Adherence" } as AnalysisBrief,
      ctxOf(summary, {})
    );
    assert.deepStrictEqual(
      (brief.outlineMetrics ?? []).sort(),
      ["Attendance Status", "Clock-In <09:30"]
    );
  });

  it("is a no-op for a numeric outcome (single-metric dashboard preserved)", () => {
    const summary = multiKpiSummary();
    const brief = ensureDashboardOutlineMetrics(
      { version: 1, requestsDashboard: true, outcomeMetricColumn: "Sales" } as AnalysisBrief,
      ctxOf(summary, {})
    );
    assert.strictEqual(brief.outlineMetrics, undefined);
  });

  it("respects an explicit outlineMetrics already on the brief", () => {
    const summary = multiKpiSummary();
    const brief = ensureDashboardOutlineMetrics(
      {
        version: 1,
        requestsDashboard: true,
        outcomeMetricColumn: "PJP Adherence",
        outlineMetrics: ["Attendance Status"],
      } as AnalysisBrief,
      ctxOf(summary, {})
    );
    assert.deepStrictEqual(brief.outlineMetrics, ["Attendance Status"]);
  });
});

describe("W6 · assertDashboardCoverage multi-KPI", () => {
  const brief = {
    version: 1,
    requestsDashboard: true,
    outcomeMetricColumn: "PJP Adherence",
    outlineMetrics: ["Attendance Status"],
    candidateDriverDimensions: ["Region", "Category"],
  } as AnalysisBrief;

  it("charts the secondary KPI (Attendance Status) by the key dims as RATE steps", () => {
    const out = assertDashboardCoverage([] as PlanStep[], brief, multiKpiSummary());
    // Find a secondary-metric step: rate alias references the secondary KPI.
    const secondarySteps = out.extensions.filter((e) => {
      const p = (e.args as { plan?: { computedAggregations?: { alias?: string }[] } }).plan;
      return p?.computedAggregations?.[0]?.alias === "Attendance Status_rate";
    });
    assert.ok(secondarySteps.length >= 1, "expected secondary KPI rate steps");
    const dims = secondarySteps.map(
      (e) => (e.args as { plan: { groupBy: string[] } }).plan.groupBy[0]
    );
    assert.deepStrictEqual(dims.sort(), ["Category", "Region"]);
  });

  it("primary outcome still charted (PJP Adherence rate by each dim)", () => {
    const out = assertDashboardCoverage([] as PlanStep[], brief, multiKpiSummary());
    const primary = out.extensions.filter((e) => {
      const p = (e.args as { plan?: { computedAggregations?: { alias?: string }[] } }).plan;
      return p?.computedAggregations?.[0]?.alias === "PJP Adherence_rate";
    });
    assert.ok(primary.length >= 1, "expected primary outcome rate steps");
  });

  it("no secondary expansion when outlineMetrics is absent (single-metric unchanged)", () => {
    const singleBrief = { ...brief, outlineMetrics: undefined } as AnalysisBrief;
    const out = assertDashboardCoverage([] as PlanStep[], singleBrief, multiKpiSummary());
    const secondary = out.extensions.some((e) => {
      const p = (e.args as { plan?: { computedAggregations?: { alias?: string }[] } }).plan;
      return p?.computedAggregations?.[0]?.alias === "Attendance Status_rate";
    });
    assert.ok(!secondary, "no secondary KPI steps without outlineMetrics");
  });
});
