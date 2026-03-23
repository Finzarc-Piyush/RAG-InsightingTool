import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSqlFromPlan } from "../lib/duckdbPlanExecutor.js";
import type { ExecutionPlan } from "../lib/analyticalQueryEngine.js";

describe("buildSqlFromPlan aggregate safety", () => {
  it("uses only whitelisted aggregate names", () => {
    const plan: ExecutionPlan = {
      description: "test",
      steps: [
        {
          step_number: 1,
          operation: "group_by",
          description: "",
          parameters: { group_by_column: "region" },
        },
        {
          step_number: 2,
          operation: "aggregate",
          description: "",
          parameters: {
            group_by_column: "region",
            agg_columns: ["sales"],
            agg_function: "sum); DROP TABLE data;--",
          },
        },
      ],
    };
    const sql = buildSqlFromPlan(plan);
    assert.ok(sql);
    assert.match(sql, /sum\(\"sales\"\)/);
    assert.ok(!/drop/i.test(sql));
  });
});
