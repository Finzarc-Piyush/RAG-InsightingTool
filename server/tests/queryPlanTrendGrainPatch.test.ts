import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchExecuteQueryPlanTrendCoarserGrain,
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
