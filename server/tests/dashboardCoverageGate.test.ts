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
      // MW2 · numeric breakdowns are size-normalized (mean), not raw sum.
      assert.strictEqual(args.aggregate, "mean");
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

describe("assertDashboardCoverage · boolean-indicator outcome", () => {
  // PJP Adherence is a boolean indicator (Yes/No/No PJP Available) — no numeric
  // form. Its per-dimension breakdown must be a countIf-RATE execute_query_plan
  // step, NOT a build_chart sum-of-strings (which renders empty/garbage).
  function makeIndicatorSummary(): DataSummary {
    const base = makeSummary();
    return {
      ...base,
      columnCount: base.columns.length + 1,
      columns: [
        ...base.columns,
        {
          name: "PJP Adherence",
          type: "string",
          sampleValues: ["Yes"],
          topValues: [
            { value: "Yes", count: 70 },
            { value: "No", count: 20 },
            { value: "No PJP Available", count: 10 },
          ],
          indicator: {
            kind: "boolean",
            positiveValues: ["Yes"],
            negativeValues: ["No"],
            sentinelValues: ["No PJP Available"],
            source: "auto",
          },
        },
      ],
    };
  }

  const indicatorBrief = makeBrief({
    outcomeMetricColumn: "PJP Adherence",
    candidateDriverDimensions: ["Region", "Category"],
  });

  it("emits execute_query_plan rate steps (not build_chart sum) for a boolean indicator", () => {
    const out = assertDashboardCoverage([], indicatorBrief, makeIndicatorSummary());
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.missingDimensions.sort(), ["Category", "Region"]);
    assert.strictEqual(out.extensions.length, 2);
    for (const ext of out.extensions) {
      assert.strictEqual(ext.tool, "execute_query_plan");
      const plan = (ext.args as { plan: any }).plan;
      assert.deepStrictEqual(plan.groupBy.length, 1);
      assert.ok(["Region", "Category"].includes(plan.groupBy[0]));
      // countIf matching/total + computed rate alias, sorted by the rate.
      assert.strictEqual(plan.aggregations.length, 2);
      assert.deepStrictEqual(
        plan.aggregations.map((a: any) => a.operation),
        ["countIf", "countIf"]
      );
      assert.strictEqual(plan.computedAggregations[0].alias, "PJP Adherence_rate");
      assert.strictEqual(plan.sort[0].column, "PJP Adherence_rate");
      // positive predicate uses the indicator's actual stored values
      assert.deepStrictEqual(plan.aggregations[0].predicate[0].values, ["Yes"]);
      // denominator excludes the sentinel "No PJP Available"
      assert.deepStrictEqual(
        plan.aggregations[1].predicate[0].values.sort(),
        ["No", "Yes"]
      );
    }
  });

  it("treats a planner execute_query_plan rate breakdown as covering its groupBy dim", () => {
    // Planner already broke PJP Adherence down by Region via execute_query_plan;
    // the gate must not duplicate it. Only Category remains uncovered.
    const plannerStep: PlanStep = {
      id: "region_rate",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Region"], aggregations: [] } },
    };
    const out = assertDashboardCoverage([plannerStep], indicatorBrief, makeIndicatorSummary());
    assert.deepStrictEqual(out.missingDimensions, ["Category"]);
    assert.strictEqual(out.extensions.length, 1);
    assert.strictEqual(out.extensions[0].tool, "execute_query_plan");
  });

  it("MW2 · numeric-outcome dashboards use size-normalized mean build_chart steps", () => {
    // Same plan, numeric outcome → build_chart steps, now aggregate=mean.
    const out = assertDashboardCoverage([], makeBrief(), makeIndicatorSummary());
    assert.strictEqual(out.extensions.length, 3);
    for (const ext of out.extensions) {
      assert.strictEqual(ext.tool, "build_chart");
      assert.strictEqual((ext.args as { aggregate: string }).aggregate, "mean");
    }
  });

  // W5 · high-cardinality entity dims (TSOE) are otherwise dropped for a boolean
  // outcome; emit a TOP-N rate leaderboard so "give me TSOE info" is answered.
  function makeTsoeSummary(): DataSummary {
    const base = makeIndicatorSummary();
    const tsoe = {
      name: "TSO_TSE Name",
      type: "string",
      sampleValues: ["A"],
      topValues: Array.from({ length: 48 }, (_, i) => ({ value: `T${i}`, count: 1 })),
    } as DataSummary["columns"][number];
    return { ...base, columnCount: base.columns.length + 1, columns: [...base.columns, tsoe] };
  }

  it("W5 · emits a TOP-N rate leaderboard for a high-cardinality entity dim (boolean outcome)", () => {
    const brief = makeBrief({
      outcomeMetricColumn: "PJP Adherence",
      candidateDriverDimensions: ["Region", "TSO_TSE Name"],
    });
    const out = assertDashboardCoverage([], brief, makeTsoeSummary());
    assert.deepStrictEqual(out.highCardinalityDimensions, ["TSO_TSE Name"]);
    const tsoeStep = out.extensions.find(
      (e) => (e.args as { plan?: { groupBy?: string[] } }).plan?.groupBy?.[0] === "TSO_TSE Name"
    );
    assert.ok(tsoeStep, "expected a TSO_TSE Name ranking extension");
    assert.strictEqual(tsoeStep!.tool, "execute_query_plan");
    const plan = (tsoeStep!.args as { plan: any }).plan;
    assert.strictEqual(plan.limit, 15);
    assert.strictEqual(plan.computedAggregations[0].alias, "PJP Adherence_rate");
    assert.strictEqual(plan.sort[0].column, "PJP Adherence_rate");
  });

  it("W5 · numeric-outcome high-card dims stay deferred to the feature sweep (no gate ranking)", () => {
    const brief = makeBrief({ candidateDriverDimensions: ["Region", "TSO_TSE Name"] }); // outcome "Sales"
    const out = assertDashboardCoverage([], brief, makeTsoeSummary());
    assert.deepStrictEqual(out.highCardinalityDimensions, ["TSO_TSE Name"]);
    const refsTsoe = out.extensions.some((e) => {
      const a = e.args as { x?: string; plan?: { groupBy?: string[] } };
      return a.x === "TSO_TSE Name" || a.plan?.groupBy?.[0] === "TSO_TSE Name";
    });
    assert.ok(!refsTsoe, "numeric high-card dim must not get a gate ranking");
  });
});

describe("assertDashboardCoverage · valid-universe scoping (W5/W6)", () => {
  // PJP Adherence gated to Market-Working days; a "PJP Planned Type" dim exists.
  function makeScopedSummary(): DataSummary {
    const base = makeSummary();
    return {
      ...base,
      columnCount: base.columns.length + 2,
      columns: [
        ...base.columns,
        {
          name: "PJP Adherence",
          type: "string",
          sampleValues: ["Yes"],
          topValues: [
            { value: "Yes", count: 70 },
            { value: "No", count: 20 },
            { value: "No PJP Available", count: 10 },
          ],
          indicator: {
            kind: "boolean",
            positiveValues: ["Yes"],
            negativeValues: ["No"],
            sentinelValues: ["No PJP Available"],
            source: "auto",
            applicabilityScope: [
              { gateColumn: "PJP Planned Type", inScopeValues: ["Market Working"] },
            ],
          },
        },
        {
          name: "PJP Planned Type",
          type: "string",
          sampleValues: ["Market Working"],
          topValues: [
            { value: "Market Working", count: 60 },
            { value: "Weekly Off", count: 20 },
            { value: "Leave", count: 20 },
          ],
        },
      ],
    };
  }

  const scopedBrief = makeBrief({
    outcomeMetricColumn: "PJP Adherence",
    candidateDriverDimensions: ["Region", "PJP Planned Type"],
  });

  it("W5 · scopes numerator AND denominator to the valid universe (Market Working)", () => {
    const out = assertDashboardCoverage([], scopedBrief, makeScopedSummary());
    const regionStep = out.extensions.find(
      (e) => (e.args as { plan?: { groupBy?: string[] } }).plan?.groupBy?.[0] === "Region"
    );
    assert.ok(regionStep, "expected a Region rate step");
    const aggs = (regionStep!.args as { plan: any }).plan.aggregations;
    for (const a of aggs) {
      const scoped = a.predicate.some(
        (p: any) => p.column === "PJP Planned Type" && p.values.includes("Market Working")
      );
      assert.ok(scoped, "both countIf predicates must be scoped to Market Working");
    }
  });

  it("W6 · skips the degenerate breakdown by the metric's own gate column", () => {
    const out = assertDashboardCoverage([], scopedBrief, makeScopedSummary());
    const refsGate = out.extensions.some(
      (e) => (e.args as { plan?: { groupBy?: string[] } }).plan?.groupBy?.[0] === "PJP Planned Type"
    );
    assert.ok(!refsGate, "must not chart adherence by its own gate column (all-zero-except-one)");
    // Region (a real dimension) is still charted.
    assert.ok(
      out.extensions.some(
        (e) => (e.args as { plan?: { groupBy?: string[] } }).plan?.groupBy?.[0] === "Region"
      )
    );
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
