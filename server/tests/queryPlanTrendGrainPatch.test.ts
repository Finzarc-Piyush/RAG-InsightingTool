import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchExecuteQueryPlanTrendCoarserGrain,
  patchExecuteQueryPlanTrendMissingGroupBy,
} from "../lib/queryPlanTemporalPatch.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

describe("patchExecuteQueryPlanTrendCoarserGrain", () => {
  it("sets month aggregation for trend question with raw date-only groupBy", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
        },
      },
    };
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "What is the sales trend over time?",
      ["Order Date"]
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, "month");
  });

  it("does not override when daily is explicit", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
        },
      },
    };
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      "Show daily sales trend",
      ["Order Date"]
    );
    const plan = step.args.plan as { dateAggregationPeriod?: string };
    assert.equal(plan.dateAggregationPeriod, undefined);
  });
});

describe("patchExecuteQueryPlanTrendMissingGroupBy", () => {
  it("injects primary date groupBy and month when trend question has aggregations but no groupBy", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
        },
      },
    };
    patchExecuteQueryPlanTrendMissingGroupBy(
      step,
      "What is the trend in sales over time?",
      ["Order Date"]
    );
    const plan = step.args.plan as {
      groupBy?: string[];
      dateAggregationPeriod?: string;
    };
    assert.deepEqual(plan.groupBy, ["Order Date"]);
    assert.equal(plan.dateAggregationPeriod, "month");
  });

  it("matches sales trend style questions (vague temporal)", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    patchExecuteQueryPlanTrendMissingGroupBy(step, "sales trend", ["Ship Date"]);
    const plan = step.args.plan as { groupBy?: string[] };
    assert.deepEqual(plan.groupBy, ["Ship Date"]);
  });

  it("does not inject when groupBy is already set", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    patchExecuteQueryPlanTrendMissingGroupBy(
      step,
      "sales trend",
      ["Order Date"]
    );
    const plan = step.args.plan as { groupBy?: string[] };
    assert.deepEqual(plan.groupBy, ["Region"]);
  });

  it("does not inject for explicit by/per breakdown questions", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    patchExecuteQueryPlanTrendMissingGroupBy(
      step,
      "sales trend by region",
      ["Order Date"]
    );
    const plan = step.args.plan as { groupBy?: string[] };
    assert.equal(plan.groupBy, undefined);
  });
});
