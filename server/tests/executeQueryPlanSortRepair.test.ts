import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeQueryPlanArgsSchema } from "../lib/queryPlanExecutor.js";
import { repairExecuteQueryPlanSort } from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

describe("execute_query_plan.sort repair", () => {
  it("fills missing sort[].direction with asc", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["__tf_month__Order_Date"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          sort: [{ column: "__tf_month__Order_Date" }],
        },
      },
    };

    const before = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(!before.success, "precondition: schema should reject missing direction");

    repairExecuteQueryPlanSort(step);

    const after = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(after.success, after.success ? "" : String(after.error));
    if (!after.success) return;
    assert.equal(after.data.plan.sort?.[0]?.direction, "asc");
  });

  it("normalizes sort aliases and drops invalid sort entries", () => {
    const step: PlanStep = {
      id: "s2",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["__tf_month__Order_Date"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          sort: [
            { field: "__tf_month__Order_Date", order: "descending" },
            { direction: "asc" },
          ],
        },
      },
    };

    repairExecuteQueryPlanSort(step);

    const after = executeQueryPlanArgsSchema.safeParse({ plan: step.args.plan });
    assert.ok(after.success, after.success ? "" : String(after.error));
    if (!after.success) return;
    assert.deepEqual(after.data.plan.sort, [
      { column: "__tf_month__Order_Date", direction: "desc" },
    ]);
  });
});
