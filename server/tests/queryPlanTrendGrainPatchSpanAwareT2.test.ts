import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchExecuteQueryPlanTrendCoarserGrain,
  pickTrendGrainForSpan,
} from "../lib/queryPlanTemporalPatch.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

/**
 * Wave T2 · the trend-grain patch now reads per-date-column dateRange to
 * pick Day / Week / Month / Quarter from the dataset's actual span. The
 * legacy "month" fallback only applies when the caller doesn't supply a
 * dateRange map (preserves pre-T2 behaviour).
 */

describe("pickTrendGrainForSpan thresholds", () => {
  it("≤ 90 days → day", () => {
    assert.equal(pickTrendGrainForSpan(1, 1), "month"); // single day → safe fallback
    assert.equal(pickTrendGrainForSpan(29, 30), "day"); // single-month dataset
    assert.equal(pickTrendGrainForSpan(90, 60), "day");
  });

  it("91-365 days → week", () => {
    assert.equal(pickTrendGrainForSpan(91, 90), "week");
    assert.equal(pickTrendGrainForSpan(365, 365), "week");
  });

  it("366 days - 5 years → month", () => {
    assert.equal(pickTrendGrainForSpan(366, 366), "month");
    assert.equal(pickTrendGrainForSpan(365 * 5, 1500), "month");
  });

  it("> 5 years → quarter", () => {
    assert.equal(pickTrendGrainForSpan(365 * 5 + 1, 2000), "quarter");
    assert.equal(pickTrendGrainForSpan(365 * 20, 7300), "quarter");
  });

  it("zero / negative span and distinctDays ≤ 1 → month fallback", () => {
    assert.equal(pickTrendGrainForSpan(0, 0), "month");
    assert.equal(pickTrendGrainForSpan(-1, 5), "month");
    assert.equal(pickTrendGrainForSpan(30, 1), "month");
    assert.equal(pickTrendGrainForSpan(Number.NaN, 5), "month");
  });
});

describe("patchExecuteQueryPlanTrendCoarserGrain · span-aware", () => {
  function makeStep(): PlanStep {
    return {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
        },
      },
    };
  }

  it("picks day grain for a 30-day narrow dataset (the Marico failure case)", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Order Date", { spanDays: 29, distinctDayCount: 30 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "How do compliance visits vary across clusters over time?",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "day");
  });

  it("picks week grain for a 200-day dataset", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Order Date", { spanDays: 200, distinctDayCount: 180 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "week");
  });

  it("picks month grain for a 3-year dataset (post-T2 ≈ pre-T2 default)", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Order Date", { spanDays: 365 * 3, distinctDayCount: 1000 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "month");
  });

  it("picks quarter grain for a 10-year dataset", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Order Date", { spanDays: 365 * 10, distinctDayCount: 3000 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "quarter");
  });

  it("falls back to month when no range map is provided (pre-T2 contract preserved)", () => {
    const step = makeStep();
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "month");
  });

  it("falls back to month when the range map omits the groupBy column", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Some Other Date", { spanDays: 30, distinctDayCount: 30 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "month");
  });

  it("still respects explicit `daily` short-circuit (user intent wins)", () => {
    const step = makeStep();
    const ranges = new Map([
      ["Order Date", { spanDays: 365 * 5, distinctDayCount: 1825 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Show daily sales trend",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    // Daily short-circuit returns before any aggregation is set; planner
    // leaves the period unbound for the executor to default to daily.
    assert.equal(plan.dateAggregationPeriod, undefined);
  });

  it("does not override an already-set dateAggregationPeriod", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
          dateAggregationPeriod: "quarter", // already set
        },
      },
    };
    const ranges = new Map([
      ["Order Date", { spanDays: 29, distinctDayCount: 30 }],
    ]);
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Sales trend over time",
      ["Order Date"],
      ranges,
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "quarter");
  });
});
