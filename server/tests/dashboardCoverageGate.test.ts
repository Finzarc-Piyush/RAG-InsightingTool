import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertDashboardCoverage,
  applyDashboardCoverage,
} from "../lib/agents/runtime/dashboardCoverageGate.js";
import type { PlanStep, AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

/**
 * DB3 · Dashboard coverage gate. Runs after the planner emits its plan; for
 * dashboard-shaped intent, every dimension named in
 * `candidateDriverDimensions ∪ segmentationDimensions` must be the x-axis of
 * at least one build_chart step. Missing low-cardinality dims get
 * deterministic build_chart extensions; high-cardinality dims defer to the
 * downstream feature-sweep (DB4).
 */

function makeBrief(overrides: Partial<AnalysisBrief> = {}): AnalysisBrief {
  return {
    requestsDashboard: true,
    outcomeMetricColumn: "Sales",
    segmentationDimensions: [],
    candidateDriverDimensions: ["Region", "Category", "Segment"],
    ...overrides,
  } as AnalysisBrief;
}

function makeSummary(overrides: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 5,
    columns: [
      {
        name: "Region",
        type: "string",
        sampleValues: ["West"],
        topValues: [
          { value: "West", count: 100 },
          { value: "East", count: 80 },
          { value: "Central", count: 60 },
          { value: "South", count: 40 },
        ],
      },
      {
        name: "Category",
        type: "string",
        sampleValues: ["Office Supplies"],
        topValues: [
          { value: "Office Supplies", count: 100 },
          { value: "Furniture", count: 80 },
          { value: "Technology", count: 60 },
        ],
      },
      {
        name: "Segment",
        type: "string",
        sampleValues: ["Consumer"],
        topValues: [
          { value: "Consumer", count: 100 },
          { value: "Corporate", count: 80 },
          { value: "Home Office", count: 60 },
        ],
      },
      { name: "Sales", type: "number", sampleValues: [12, 99] },
      { name: "Order Date", type: "date", sampleValues: ["2020-01-01"] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    ...overrides,
  };
}

function buildChartStep(x: string, y = "Sales"): PlanStep {
  return {
    id: `s_${x}`,
    tool: "build_chart",
    args: { type: "bar", x, y, aggregate: "sum" },
  };
}

describe("assertDashboardCoverage", () => {
  it("is a no-op when brief is undefined", () => {
    const out = assertDashboardCoverage([], undefined, makeSummary());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.extensions.length, 0);
  });

  it("is a no-op when requestsDashboard is false", () => {
    const brief = makeBrief({ requestsDashboard: false });
    const out = assertDashboardCoverage([], brief, makeSummary());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.extensions.length, 0);
  });

  it("is a no-op when brief has no outcomeMetricColumn", () => {
    const brief = makeBrief({ outcomeMetricColumn: undefined });
    const out = assertDashboardCoverage([], brief, makeSummary());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.extensions.length, 0);
  });

  it("returns ok=true when plan covers every required dimension", () => {
    const brief = makeBrief();
    const plan = [
      buildChartStep("Region"),
      buildChartStep("Category"),
      buildChartStep("Segment"),
    ];
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.missingDimensions.length, 0);
    assert.strictEqual(out.extensions.length, 0);
  });

  it("appends a build_chart step for each missing low-cardinality dim", () => {
    const brief = makeBrief();
    const plan = [buildChartStep("Region")]; // covers Region only
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.missingDimensions.sort(), ["Category", "Segment"]);
    assert.strictEqual(out.extensions.length, 2);
    for (const ext of out.extensions) {
      assert.strictEqual(ext.tool, "build_chart");
      const args = ext.args as { type: string; x: string; y: string; aggregate: string };
      assert.strictEqual(args.type, "bar");
      assert.strictEqual(args.y, "Sales");
      assert.strictEqual(args.aggregate, "sum");
      assert.ok(["Category", "Segment"].includes(args.x));
    }
  });

  it("merges segmentationDimensions and candidateDriverDimensions", () => {
    const brief = makeBrief({
      segmentationDimensions: ["Region"],
      candidateDriverDimensions: ["Category"],
    });
    const plan: PlanStep[] = [];
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    assert.deepStrictEqual(out.missingDimensions.sort(), ["Category", "Region"]);
  });

  it("treats high-cardinality dims as deferred (no extension; reported separately)", () => {
    // ProductSKU has a saturated topValues list (length === 48)
    const sku = {
      name: "ProductSKU",
      type: "string",
      sampleValues: ["S0"],
      topValues: Array.from({ length: 48 }, (_, i) => ({ value: `S${i}`, count: 1 })),
    };
    const summary = makeSummary({
      columnCount: 6,
      columns: [...makeSummary().columns, sku],
    });
    const brief = makeBrief({ candidateDriverDimensions: ["Region", "ProductSKU"] });
    const plan = [buildChartStep("Region")];
    const out = assertDashboardCoverage(plan, brief, summary);
    assert.deepStrictEqual(out.missingDimensions, []);
    assert.deepStrictEqual(out.highCardinalityDimensions, ["ProductSKU"]);
    assert.strictEqual(out.extensions.length, 0);
  });

  it("ignores brief dimensions that are not in the schema", () => {
    const brief = makeBrief({ candidateDriverDimensions: ["NotARealColumn", "Region"] });
    const plan: PlanStep[] = [];
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    assert.deepStrictEqual(out.missingDimensions, ["Region"]);
  });

  it("does not chart numeric or date columns even if brief named them", () => {
    const brief = makeBrief({ candidateDriverDimensions: ["Sales", "Order Date", "Region"] });
    const plan: PlanStep[] = [];
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    // Sales (numeric) and Order Date (date) are not categorical → unknown bucket → silent
    assert.deepStrictEqual(out.missingDimensions, ["Region"]);
  });

  it("does not duplicate the outcome metric as a chart x-axis", () => {
    const brief = makeBrief({ candidateDriverDimensions: ["Sales", "Region"] });
    const plan: PlanStep[] = [];
    const out = assertDashboardCoverage(plan, brief, makeSummary());
    assert.deepStrictEqual(out.missingDimensions, ["Region"]);
  });
});

describe("applyDashboardCoverage", () => {
  it("mutates the plan in place by appending coverage steps", () => {
    const ctx = {
      analysisBrief: makeBrief(),
      summary: makeSummary(),
    } as unknown as AgentExecutionContext;
    const plan: PlanStep[] = [buildChartStep("Region")];
    const before = plan.length;
    const result = applyDashboardCoverage(plan, ctx);
    assert.strictEqual(plan.length, before + result.extensions.length);
    assert.ok(result.extensions.length >= 2);
    // Appended steps live at the tail
    assert.strictEqual(plan[before].tool, "build_chart");
  });

  it("does not mutate the plan when coverage is already complete", () => {
    const ctx = {
      analysisBrief: makeBrief(),
      summary: makeSummary(),
    } as unknown as AgentExecutionContext;
    const plan = [
      buildChartStep("Region"),
      buildChartStep("Category"),
      buildChartStep("Segment"),
    ];
    const before = plan.length;
    const result = applyDashboardCoverage(plan, ctx);
    assert.strictEqual(plan.length, before);
    assert.strictEqual(result.ok, true);
  });
});
