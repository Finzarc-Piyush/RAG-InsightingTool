/**
 * Wave PD1 · `injectPerDimensionForRateIntent` rewrites the planner's
 * single-pass aggregation into a nested-aggregation shape when the
 * detected intent matches. Idempotent, scoped, and respectful of plans
 * the planner LLM already decomposed correctly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  injectPerDimensionForRateIntent,
  type PerXIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

const MARICO_INTENT: PerXIntent = {
  outerOp: "mean",
  perDimension: "Day · TSOE-Date Combo",
  perDimensionKind: "temporal",
  rawCapture: "day",
};

function step(
  args: Record<string, unknown>,
  tool: PlanStep["tool"] = "execute_query_plan"
): PlanStep {
  return {
    id: "s1",
    tool,
    args,
  } as PlanStep;
}

describe("Wave PD1 · injectPerDimensionForRateIntent", () => {
  it("rewrites the Marico screenshot scenario (mean(Compliance Visit) GROUP BY Cluster → nested)", () => {
    const s = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean" },
        ],
      },
    });
    const result = injectPerDimensionForRateIntent(s, MARICO_INTENT);
    assert.deepEqual(result.rewrittenAggColumns, ["Compliance Visit"]);
    const plan = s.args.plan as { aggregations: Array<Record<string, unknown>> };
    assert.equal(plan.aggregations[0]!.perDimension, "Day · TSOE-Date Combo");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");
    assert.equal(plan.aggregations[0]!.operation, "mean");
    assert.equal(plan.aggregations[0]!.column, "Compliance Visit");
  });

  it("is idempotent — already-nested aggregations are not double-rewritten", () => {
    const s = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          {
            column: "Compliance Visit",
            operation: "mean",
            perDimension: "Day · TSOE-Date Combo",
            innerOperation: "sum",
          },
        ],
      },
    });
    const result = injectPerDimensionForRateIntent(s, MARICO_INTENT);
    assert.equal(result.rewrittenAggColumns.length, 0);
    assert.equal(result.skipReason, "already_nested");
  });

  it("skips when the planner already grouped by the perDimension (trend intent, not rate)", () => {
    const s = step({
      plan: {
        groupBy: ["Cluster Name", "Day · TSOE-Date Combo"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean" },
        ],
      },
    });
    const result = injectPerDimensionForRateIntent(s, MARICO_INTENT);
    assert.equal(result.rewrittenAggColumns.length, 0);
    assert.equal(result.skipReason, "already_in_group_by");
  });

  it("skips when the aggregation operation doesn't match the detected outer op", () => {
    // Question said "average per day" (mean intent) but planner emitted SUM —
    // don't second-guess the planner; leave it alone.
    const s = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: "sum" },
        ],
      },
    });
    const result = injectPerDimensionForRateIntent(s, MARICO_INTENT);
    assert.equal(result.rewrittenAggColumns.length, 0);
    assert.equal(result.skipReason, "no_matching_aggregation");
  });

  it("skips when intent is null (non-rate question)", () => {
    const s = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [{ column: "Sales", operation: "mean" }],
      },
    });
    const result = injectPerDimensionForRateIntent(s, null);
    assert.equal(result.rewrittenAggColumns.length, 0);
    assert.equal(result.skipReason, "no_intent");
  });

  it("skips countIf/sumIf aggregations even when the outer op nominally matches", () => {
    const sumIntent: PerXIntent = {
      outerOp: "sum",
      perDimension: "Day · TSOE-Date Combo",
      perDimensionKind: "temporal",
      rawCapture: "day",
    };
    const s = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          {
            column: "*",
            operation: "sumIf",
            predicate: [{ column: "Cluster Name", op: "in", values: ["West"] }],
            alias: "matching",
          },
        ],
      },
    });
    const result = injectPerDimensionForRateIntent(s, sumIntent);
    assert.equal(result.rewrittenAggColumns.length, 0);
  });

  it("ignores non-execute_query_plan tools", () => {
    const s = step({ table: { rows: [] } }, "build_chart");
    const result = injectPerDimensionForRateIntent(s, MARICO_INTENT);
    assert.equal(result.skipReason, "not_execute_query_plan");
  });
});
