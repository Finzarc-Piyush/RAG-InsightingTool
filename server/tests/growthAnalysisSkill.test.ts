// WGR4 · growth_analysis skill — pin activation rules and emitted plan
// shape. Priority test confirms timeWindowDiff still wins on explicit
// comparisonPeriods.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import { growthAnalysisSkill } from "../lib/agents/runtime/skills/growthAnalysis.js";
import { timeWindowDiffSkill } from "../lib/agents/runtime/skills/timeWindowDiff.js";

const summaryWithDate = (): DataSummary =>
  ({
    columnCount: 4,
    rowCount: 100,
    columns: [
      { name: "Markets", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Order Date", type: "date", sampleValues: [], nullCount: 0 },
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  }) as unknown as DataSummary;

const summaryWithoutDate = (): DataSummary =>
  ({
    columnCount: 3,
    rowCount: 50,
    columns: [
      { name: "Markets", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  }) as unknown as DataSummary;

const summaryWithWideFormat = (): DataSummary =>
  ({
    columnCount: 5,
    rowCount: 100,
    columns: [
      { name: "Markets", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Period", type: "string", sampleValues: [], nullCount: 0 },
      { name: "PeriodIso", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Value", type: "number", sampleValues: [], nullCount: 0 },
      { name: "Metric", type: "string", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Value"],
    dateColumns: [],
    wideFormatTransform: {
      detected: true,
      shape: "pure_period",
      idColumns: ["Markets"],
      meltedColumns: ["Q1 22"],
      periodCount: 12,
      periodColumn: "Period",
      periodIsoColumn: "PeriodIso",
      periodKindColumn: "PeriodKind",
      valueColumn: "Value",
      detectedCurrencySymbol: "đ",
    },
  }) as unknown as DataSummary;

function ctx(
  question: string,
  summary: DataSummary,
  data: Record<string, unknown>[] = []
): AgentExecutionContext {
  return {
    sessionId: "s",
    question,
    data,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as unknown as AgentExecutionContext;
}

/** 5-year × 12-month wide-format-ish PeriodIso fixture (no actual values
 *  needed — the seasonality coverage detector only inspects the period
 *  column). */
function multiYearMonthlyData(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let y = 2018; y <= 2022; y++) {
    for (let m = 1; m <= 12; m++) {
      const mm = m < 10 ? `0${m}` : String(m);
      rows.push({ Markets: "VN", PeriodIso: `${y}-${mm}`, Sales: 100 });
    }
  }
  return rows;
}

/** Single-year fixture — does NOT qualify for seasonality. */
function singleYearMonthlyData(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let m = 1; m <= 12; m++) {
    const mm = m < 10 ? `0${m}` : String(m);
    rows.push({ Markets: "VN", PeriodIso: `2024-${mm}`, Sales: 100 });
  }
  return rows;
}

const trendBrief = (partial?: Partial<AnalysisBrief>): AnalysisBrief => ({
  version: 1,
  questionShape: "trend",
  outcomeMetricColumn: "Sales",
  segmentationDimensions: ["Markets"],
  candidateDriverDimensions: ["Region"],
  clarifyingQuestions: [],
  epistemicNotes: [],
  ...partial,
});

describe("WGR4 · growthAnalysisSkill · appliesTo", () => {
  it("applies for questionShape='trend' with outcome + temporal column", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief(),
        ctx("how is value sales trending?", summaryWithDate())
      ),
      true
    );
  });

  it("applies on growth keywords even when shape isn't 'trend'", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief({ questionShape: "exploration" }),
        ctx("which is the fastest growing market?", summaryWithDate())
      ),
      true
    );
  });

  it("applies for wide-format-melted datasets via PeriodIso", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief({ outcomeMetricColumn: "Value" }),
        ctx("show value over time", summaryWithWideFormat())
      ),
      true
    );
  });

  it("does NOT apply when no temporal column exists", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief(),
        ctx("how is value trending?", summaryWithoutDate())
      ),
      false
    );
  });

  it("does NOT apply without outcome metric", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief({ outcomeMetricColumn: undefined }),
        ctx("trend over time", summaryWithDate())
      ),
      false
    );
  });

  it("does NOT apply when explicit comparisonPeriods are present (timeWindowDiff wins)", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief({
          questionShape: "comparison",
          comparisonPeriods: {
            a: [{ column: "Order Date", op: "in", values: ["2022-03"] }],
            b: [{ column: "Order Date", op: "in", values: ["2025-04"] }],
            aLabel: "Mar-22",
            bLabel: "Apr-25",
          },
        }),
        ctx("compare mar-22 vs apr-25", summaryWithDate())
      ),
      false
    );
  });

  it("does NOT apply on non-temporal descriptive questions without growth keywords", () => {
    assert.equal(
      growthAnalysisSkill.appliesTo(
        trendBrief({ questionShape: "descriptive" }),
        ctx("what is my top region by revenue?", summaryWithDate())
      ),
      false
    );
  });
});

describe("WGR4 · growthAnalysisSkill · plan emission", () => {
  it("emits compute_growth in rankByGrowth mode for 'fastest growing' questions", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief(),
      ctx("which is the fastest growing market?", summaryWithDate())
    );
    assert.ok(plan);
    const rank = plan!.steps.find((s) => s.tool === "compute_growth");
    assert.ok(rank);
    assert.equal((rank!.args as any).mode, "rankByGrowth");
    assert.equal((rank!.args as any).dimensionColumn, "Markets");
    // Bar chart depends on the rank.
    const chart = plan!.steps.find((s) => s.tool === "build_chart");
    assert.ok(chart);
    assert.equal(chart!.dependsOn, "ga_rank");
    assert.equal((chart!.args as any).type, "bar");
  });

  it("emits series + summary + line chart for open-ended trend questions", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief(),
      ctx("how has value sales trended over the years?", summaryWithDate())
    );
    assert.ok(plan);
    const computes = plan!.steps.filter((s) => s.tool === "compute_growth");
    // series + summary
    assert.equal(computes.length, 2);
    const modes = computes.map((s) => (s.args as any).mode).sort();
    assert.deepEqual(modes, ["series", "summary"]);
    const chart = plan!.steps.find((s) => s.tool === "build_chart");
    assert.equal((chart!.args as any).type, "line");
    assert.equal(chart!.dependsOn, "ga_summary");
  });

  it("uses PeriodIso column when wideFormatTransform is detected", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({ outcomeMetricColumn: "Value" }),
      ctx("how is value growing?", summaryWithWideFormat())
    );
    assert.ok(plan);
    const compute = plan!.steps.find((s) => s.tool === "compute_growth")!;
    assert.equal((compute.args as any).periodIsoColumn, "PeriodIso");
    assert.equal((compute.args as any).dateColumn, undefined);
  });

  it("starts with retrieve_semantic_context (RAG round-1)", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief(),
      ctx("how has value sales trended?", summaryWithDate())
    );
    assert.equal(plan!.steps[0].tool, "retrieve_semantic_context");
  });

  it("respects yearly grain preference from brief", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({
        timeWindow: { description: "by year", grainPreference: "yearly" },
      }),
      ctx("year over year growth", summaryWithDate())
    );
    const compute = plan!.steps.find((s) => s.tool === "compute_growth")!;
    assert.equal((compute.args as any).grain, "yoy");
  });
});

describe("WGR4 · growthAnalysisSkill · priority ordering vs timeWindowDiff", () => {
  it("growthAnalysis priority is below timeWindowDiff so explicit-A-vs-B questions still win", () => {
    const tw = timeWindowDiffSkill.priority ?? 0;
    const ga = growthAnalysisSkill.priority ?? 0;
    assert.ok(ga < tw, `growthAnalysis (${ga}) must rank below timeWindowDiff (${tw})`);
  });

  it("growthAnalysis priority is above default (varianceDecomposer / driverDiscovery / insightExplorer)", () => {
    const ga = growthAnalysisSkill.priority ?? 0;
    assert.ok(ga > 0, `growthAnalysis priority must be > 0; got ${ga}`);
  });
});

describe("WSE4 · growthAnalysisSkill · auto-emits detect_seasonality", () => {
  it("emits a detect_seasonality step on multi-year monthly data", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({ outcomeMetricColumn: "Sales" }),
      ctx(
        "how has sales trended over the years?",
        summaryWithWideFormat(),
        multiYearMonthlyData()
      )
    );
    assert.ok(plan);
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.ok(seasonality, "detect_seasonality step must be emitted");
    assert.equal((seasonality!.args as any).granularity, "auto");
    assert.equal((seasonality!.args as any).periodIsoColumn, "PeriodIso");
    assert.equal(seasonality!.parallelGroup, "ga_parallel");
  });

  it("does NOT emit detect_seasonality on single-year data", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({ outcomeMetricColumn: "Sales" }),
      ctx(
        "how has sales trended this year?",
        summaryWithWideFormat(),
        singleYearMonthlyData()
      )
    );
    assert.ok(plan);
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.equal(seasonality, undefined, "detect_seasonality must NOT be emitted on single-year data");
  });

  it("does NOT emit detect_seasonality on rankByGrowth questions", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({ outcomeMetricColumn: "Sales" }),
      ctx(
        "which is the fastest growing market?",
        summaryWithWideFormat(),
        multiYearMonthlyData()
      )
    );
    assert.ok(plan);
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.equal(seasonality, undefined, "rank-by-growth questions skip seasonality");
  });

  it("the seasonality step shares parallelGroup with compute_growth so they run concurrently", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({ outcomeMetricColumn: "Sales" }),
      ctx(
        "what's the trend?",
        summaryWithWideFormat(),
        multiYearMonthlyData()
      )
    );
    const groups = new Set(
      plan!.steps
        .filter((s) => s.parallelGroup)
        .map((s) => s.parallelGroup)
    );
    assert.equal(groups.size, 1, "all parallel steps share one group");
    const parallelTools = plan!.steps
      .filter((s) => s.parallelGroup === "ga_parallel")
      .map((s) => s.tool)
      .sort();
    assert.ok(parallelTools.includes("compute_growth"));
    assert.ok(parallelTools.includes("detect_seasonality"));
  });

  it("propagates dimensionFilters from the brief into the seasonality step", () => {
    const plan = growthAnalysisSkill.plan(
      trendBrief({
        outcomeMetricColumn: "Sales",
        filters: [
          { column: "Region", op: "in", values: ["West"] },
        ],
      }),
      ctx(
        "trend in West?",
        summaryWithWideFormat(),
        multiYearMonthlyData()
      )
    );
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality")!;
    const filters = (seasonality.args as any).dimensionFilters;
    assert.ok(Array.isArray(filters));
    assert.equal(filters[0].column, "Region");
    assert.deepEqual(filters[0].values, ["West"]);
  });
});
