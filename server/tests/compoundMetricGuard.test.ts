// WPF2 · Unit tests for injectCompoundShapeMetricGuard.
// Locks in: silent-SUM-across-mixed-metrics is prevented on every tool that
// touches the wide-format value column.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  injectCompoundShapeMetricGuard,
  resolveMetricFromQuestion,
  extractDistinctMetricValues,
} from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";
import type { WideFormatTransform } from "../shared/schema.js";

const compoundTransform: WideFormatTransform = {
  detected: true,
  shape: "compound",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Q1 23 Value Sales", "Q1 23 Volume"],
  periodCount: 2,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  metricColumn: "Metric",
  detectedCurrencySymbol: "đ",
};

const purePeriodTransform: WideFormatTransform = {
  ...compoundTransform,
  shape: "pure_period",
  metricColumn: undefined,
};

const distinctMetrics = ["value_sales", "volume"];

function executeQueryPlanStep(plan: Record<string, unknown>): PlanStep {
  return {
    id: "s1",
    tool: "execute_query_plan",
    args: { plan },
  };
}

describe("WPF2 · resolveMetricFromQuestion", () => {
  it("matches sales keyword to value_sales metric", () => {
    assert.deepEqual(
      resolveMetricFromQuestion("show me sales by Markets", distinctMetrics),
      ["value_sales"]
    );
  });

  it("matches revenue keyword to value_sales metric", () => {
    assert.deepEqual(
      resolveMetricFromQuestion("compare revenue across Q1 24 and Q1 23", distinctMetrics),
      ["value_sales"]
    );
  });

  it("matches volume keyword to volume metric", () => {
    assert.deepEqual(
      resolveMetricFromQuestion("trend of volume over time", distinctMetrics),
      ["volume"]
    );
  });

  it("matches both metrics when user asks for cross-metric comparison", () => {
    assert.deepEqual(
      resolveMetricFromQuestion("compare value sales vs volume", distinctMetrics),
      ["value_sales", "volume"]
    );
  });

  it("returns empty when no keyword fires", () => {
    assert.deepEqual(
      resolveMetricFromQuestion("how is Marico doing this year", distinctMetrics),
      []
    );
  });

  it("returns empty for empty question or empty distincts", () => {
    assert.deepEqual(resolveMetricFromQuestion("", distinctMetrics), []);
    assert.deepEqual(resolveMetricFromQuestion("show me sales", []), []);
  });
});

describe("WPF2 · injectCompoundShapeMetricGuard — execute_query_plan", () => {
  it("injects metric filter when sum(Value) without filter, sales mention", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me sales by Markets",
      distinctMetrics
    );
    assert.deepEqual(r.injectedFilter, ["value_sales"]);
    const filters = (step.args.plan as any).dimensionFilters as any[];
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Metric");
    assert.equal(filters[0].op, "in");
    assert.deepEqual(filters[0].values, ["value_sales"]);
    assert.equal(filters[0].match, "case_insensitive");
  });

  it("preserves existing dimensionFilters when injecting metric filter", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
      dimensionFilters: [
        { column: "Markets", op: "in", values: ["Off VN"] },
      ],
    });
    injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me volume by Markets",
      distinctMetrics
    );
    const filters = (step.args.plan as any).dimensionFilters as any[];
    assert.equal(filters.length, 2);
    assert.equal(filters[0].column, "Markets");
    assert.equal(filters[1].column, "Metric");
    assert.deepEqual(filters[1].values, ["volume"]);
  });

  it("expands groupBy with Metric column for cross-metric questions", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "compare value sales vs volume by Markets",
      distinctMetrics
    );
    assert.equal(r.expandedGroupBy, true);
    assert.deepEqual((step.args.plan as any).groupBy, ["Metric", "Markets"]);
    const filters = (step.args.plan as any).dimensionFilters;
    assert.equal(
      filters,
      undefined,
      "cross-metric expansion must NOT also inject a single-metric filter"
    );
  });

  it("falls back to value_sales heuristic when no metric keyword in question", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "how is Marico doing in Q1 23",
      distinctMetrics
    );
    assert.equal(r.fallbackUsed, true);
    assert.deepEqual(r.injectedFilter, ["value_sales"]);
  });

  it("no-op when metric filter already present", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
      dimensionFilters: [
        { column: "Metric", op: "in", values: ["volume"] },
      ],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me sales by Markets",
      distinctMetrics
    );
    assert.equal(r.reason, "metric_filter_already_present");
    const filters = (step.args.plan as any).dimensionFilters as any[];
    assert.equal(filters.length, 1, "must not duplicate the metric filter");
  });

  it("no-op when groupBy already includes Metric (cross-metric intent)", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Metric", "Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me sales by Markets",
      distinctMetrics
    );
    assert.equal(r.reason, "metric_in_group_by");
  });

  it("no-op on non-compound shape", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      purePeriodTransform,
      "show me sales by Markets",
      distinctMetrics
    );
    assert.equal(r.reason, "not_compound");
  });

  it("no-op when step does not touch the value column", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "SomeOtherColumn", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me sales by Markets",
      distinctMetrics
    );
    assert.equal(r.reason, "no_value_touch");
  });
});

describe("WPF2 · injectCompoundShapeMetricGuard — other tools", () => {
  it("guards breakdown_ranking when metricColumn === valueColumn", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: {
        metricColumn: "Value",
        breakdownColumn: "Markets",
        aggregation: "sum",
      },
    };
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "rank Markets by sales",
      distinctMetrics
    );
    assert.deepEqual(r.injectedFilter, ["value_sales"]);
    const filters = (step.args as any).dimensionFilters as any[];
    assert.equal(filters[0].column, "Metric");
  });

  it("guards run_two_segment_compare when metricColumn === valueColumn", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "run_two_segment_compare",
      args: {
        metricColumn: "Value",
        segment_a_filters: [],
        segment_b_filters: [],
      },
    };
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "compare volume between Marico and Olive",
      distinctMetrics
    );
    assert.deepEqual(r.injectedFilter, ["volume"]);
  });

  it("guards run_correlation when targetVariable === valueColumn", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "run_correlation",
      args: { targetVariable: "Value" },
    };
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "what drives sales",
      distinctMetrics
    );
    assert.deepEqual(r.injectedFilter, ["value_sales"]);
  });

  it("guards run_segment_driver_analysis when outcomeColumn === valueColumn", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "run_segment_driver_analysis",
      args: { outcomeColumn: "Value" },
    };
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "what drives revenue in Off VN",
      distinctMetrics
    );
    assert.deepEqual(r.injectedFilter, ["value_sales"]);
  });

  it("returns no_metrics_known when distinct values list is empty", () => {
    const step = executeQueryPlanStep({
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectCompoundShapeMetricGuard(
      step,
      compoundTransform,
      "show me sales",
      []
    );
    assert.equal(r.reason, "no_metrics_known");
  });
});

describe("WPF2 · extractDistinctMetricValues", () => {
  it("returns insertion-ordered distincts capped at the limit", () => {
    const rows = [
      { Metric: "value_sales", Value: 1 },
      { Metric: "volume", Value: 2 },
      { Metric: "value_sales", Value: 3 },
      { Metric: "units", Value: 4 },
    ];
    assert.deepEqual(
      extractDistinctMetricValues(rows, "Metric"),
      ["value_sales", "volume", "units"]
    );
  });

  it("trims whitespace and skips non-string values", () => {
    const rows = [
      { Metric: "  value_sales  " },
      { Metric: 42 },
      { Metric: "" },
      { Metric: null },
      { Metric: "volume" },
    ];
    assert.deepEqual(
      extractDistinctMetricValues(rows, "Metric"),
      ["value_sales", "volume"]
    );
  });
});
