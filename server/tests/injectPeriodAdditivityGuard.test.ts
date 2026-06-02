// Layer B · injectPeriodAdditivityGuard — deterministic backstop that prevents
// SUM(Value) across the non-additive, overlapping period rows of a melted
// pure_period dataset. Defaults to the latest-12-months rollup (PeriodIso=L12M);
// an explicitly-named period wins; groupBy-on-period is the trend escape hatch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectPeriodAdditivityGuard } from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";
import type { WideFormatTransform } from "../shared/schema.js";

const purePeriodTransform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Latest 12 Mths", "Q1 23"],
  periodCount: 18,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

const ISO = ["L12M", "L12M-YA", "L12M-2YA", "YTD-TY", "2023-Q1", "2024-Q1", "2025-Q4"];
const KIND = ["quarter", "latest_n", "ytd"];

const eqpStep = (plan: Record<string, unknown>): PlanStep => ({
  id: "s1",
  tool: "execute_query_plan",
  args: { plan },
});

function filtersOf(step: PlanStep): Array<Record<string, unknown>> {
  if (step.tool === "execute_query_plan") {
    const plan = (step.args as { plan?: Record<string, unknown> }).plan ?? {};
    return (plan.dimensionFilters as Array<Record<string, unknown>>) ?? [];
  }
  return ((step.args as Record<string, unknown>).dimensionFilters as Array<Record<string, unknown>>) ?? [];
}

describe("injectPeriodAdditivityGuard · default + happy path", () => {
  it("SUM(Value) groupBy [Products] with no period filter → injects PeriodIso=L12M + caveat", () => {
    const step = eqpStep({
      groupBy: ["Products"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectPeriodAdditivityGuard(
      step,
      purePeriodTransform,
      "which product had the highest sales value",
      ISO,
      KIND
    );
    assert.equal(r.injectedFilter?.column, "PeriodIso");
    assert.deepEqual(r.injectedFilter?.values, ["L12M"]);
    assert.match(r.caveat ?? "", /latest 12 months/i);
    const f = filtersOf(step);
    assert.ok(
      f.some((x) => x.column === "PeriodIso" && Array.isArray(x.values) && (x.values as string[])[0] === "L12M"),
      "PeriodIso=L12M filter was added to the plan"
    );
  });

  it("breakdown_ranking with metricColumn=Value → injects top-level PeriodIso filter", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: { metricColumn: "Value", breakdownColumn: "Products", topN: 1 },
    };
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "highest product", ISO, KIND);
    assert.deepEqual(r.injectedFilter?.values, ["L12M"]);
    assert.ok(filtersOf(step).some((x) => x.column === "PeriodIso"));
  });

  it("run_correlation with targetVariable=Value → guarded", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "run_correlation",
      args: { targetVariable: "Value", drivers: ["X"] },
    };
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "what drives value", ISO, KIND);
    assert.equal(r.injectedFilter?.column, "PeriodIso");
  });
});

describe("injectPeriodAdditivityGuard · escape hatches & no-ops", () => {
  it("groupBy includes a period column → no-op (quarterly trend)", () => {
    const step = eqpStep({
      groupBy: ["PeriodIso"],
      aggregations: [{ column: "Value", operation: "sum" }],
    });
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "quarterly sales trend", ISO, KIND);
    assert.equal(r.reason, "period_in_group_by");
    assert.equal(filtersOf(step).length, 0);
  });

  it("an existing PeriodKind filter → no-op", () => {
    const step = eqpStep({
      groupBy: ["Products"],
      aggregations: [{ column: "Value", operation: "sum" }],
      dimensionFilters: [{ column: "PeriodKind", op: "in", values: ["quarter"] }],
    });
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "latest 12 months", ISO, KIND);
    assert.equal(r.reason, "period_filter_already_present");
  });

  it("step does not touch Value → no_value_touch", () => {
    const step = eqpStep({
      groupBy: ["Products"],
      aggregations: [{ column: "OtherMetric", operation: "sum" }],
    });
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "x", ISO, KIND);
    assert.equal(r.reason, "no_value_touch");
  });

  it("compound shape → not_pure_period", () => {
    const compound = { ...purePeriodTransform, shape: "compound" as const, metricColumn: "Metric" };
    const step = eqpStep({ groupBy: ["Products"], aggregations: [{ column: "Value", operation: "sum" }] });
    const r = injectPeriodAdditivityGuard(step, compound, "x", ISO, KIND);
    assert.equal(r.reason, "not_pure_period");
  });

  it("is idempotent — second run sees the injected filter and no-ops", () => {
    const step = eqpStep({ groupBy: ["Products"], aggregations: [{ column: "Value", operation: "sum" }] });
    injectPeriodAdditivityGuard(step, purePeriodTransform, "highest product", ISO, KIND);
    const r2 = injectPeriodAdditivityGuard(step, purePeriodTransform, "highest product", ISO, KIND);
    assert.equal(r2.reason, "period_filter_already_present");
    assert.equal(filtersOf(step).filter((x) => x.column === "PeriodIso").length, 1);
  });
});

describe("injectPeriodAdditivityGuard · explicit period & fallbacks", () => {
  it("explicit 'Q1 2024' in the question → injects 2024-Q1, not L12M", () => {
    const step = eqpStep({ groupBy: ["Products"], aggregations: [{ column: "Value", operation: "sum" }] });
    const r = injectPeriodAdditivityGuard(
      step,
      purePeriodTransform,
      "Sales Value by product in Q1 2024",
      ISO,
      KIND
    );
    assert.deepEqual(r.injectedFilter?.values, ["2024-Q1"]);
  });

  it("no L12M rollup in catalog → pins to the latest calendar period", () => {
    const step = eqpStep({ groupBy: ["Products"], aggregations: [{ column: "Value", operation: "sum" }] });
    const r = injectPeriodAdditivityGuard(
      step,
      purePeriodTransform,
      "highest product",
      ["2023-Q1", "2024-Q1", "2025-Q4"],
      ["quarter"]
    );
    assert.deepEqual(r.injectedFilter?.values, ["2025-Q4"]);
  });

  it("no period catalog at all → no_period_catalog (no injection)", () => {
    const step = eqpStep({ groupBy: ["Products"], aggregations: [{ column: "Value", operation: "sum" }] });
    const r = injectPeriodAdditivityGuard(step, purePeriodTransform, "highest product", [], []);
    assert.equal(r.reason, "no_period_catalog");
    assert.equal(filtersOf(step).length, 0);
  });
});
