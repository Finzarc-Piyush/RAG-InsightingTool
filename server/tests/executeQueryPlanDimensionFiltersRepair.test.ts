import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeQueryPlanArgsSchema } from "../lib/queryPlanExecutor.js";
import { repairExecuteQueryPlanDimensionFilters } from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

describe("execute_query_plan.dimensionFilters repair", () => {
  it("sets missing dimensionFilters[].op to 'in'", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          dimensionFilters: [{ column: "Segment", values: ["West"] }],
        },
      },
    };

    const before = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(!before.success, "precondition: schema should reject missing op");

    repairExecuteQueryPlanDimensionFilters(step);

    const after = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(after.success, after.success ? "" : String(after.error));
  });

  it("maps dimensionFilters[].operator to op when provided", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          dimensionFilters: [{ column: "Segment", operator: "in", values: ["West"] }],
        },
      },
    };

    repairExecuteQueryPlanDimensionFilters(step);

    const after = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(after.success, after.success ? "" : String(after.error));
  });
});

