/**
 * Wave PD3 · `injectMultiPerIntent` aggressively rewrites plans that
 * conflated rate denominator + group dimension. The user's question is
 * "average X per Y per Z" → planner often emits `groupBy: [Z, Y]` (trend
 * with breakdown) → PD3 MOVES Y out of groupBy into `perDimension`,
 * leaving `groupBy: [Z]` and `aggregations: [{ ..., perDimension: Y_facet,
 * innerOperation: "sum" }]` (rate-per-group).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  injectMultiPerIntent,
  type MultiPerIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

const MARICO_INTENT: MultiPerIntent = {
  outerOp: "mean",
  rateDenominator: {
    column: "Day · Date",
    sourceColumn: "Date",
    grain: "date",
  },
  groupColumns: ["Cluster Name"],
  rawCaptures: ["day", "cluster"],
};

function planStep(args: Record<string, unknown>, tool: PlanStep["tool"] = "execute_query_plan"): PlanStep {
  return { id: "s1", tool, args } as PlanStep;
}

describe("Wave PD3 · injectMultiPerIntent — the Marico failing scenario", () => {
  it("(a) PRIMARY: moves raw 'Date' out of groupBy and adds perDimension to the agg", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name", "Date"],
        aggregations: [
          {
            column: "Compliance Visit",
            operation: "mean",
            alias: "average_compliance_visits_per_day",
          },
        ],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.deepEqual(result.rewrittenAggColumns, ["Compliance Visit"]);
    assert.deepEqual(result.removedFromGroupBy, ["Date"]);
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    // groupBy now ONLY contains the answer dimension
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
    // The aggregation is now nested
    assert.equal(plan.aggregations[0]!.perDimension, "Day · Date");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");
    // The user's explicit alias survives
    assert.equal(
      plan.aggregations[0]!.alias,
      "average_compliance_visits_per_day"
    );
  });

  it("(b) moves 'Day · Date' (literal facet form) out of groupBy", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name", "Day · Date"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean" },
        ],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.deepEqual(result.removedFromGroupBy, ["Day · Date"]);
    const plan = step.args.plan as { groupBy: string[] };
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
  });

  it("(c) moves 'Week · Date' (different facet over same source) out of groupBy", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name", "Week · Date"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean" },
        ],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.deepEqual(result.removedFromGroupBy, ["Week · Date"]);
  });

  it("(d) skips when rate denominator NOT in groupBy (planner emitted single-pass)", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean" },
        ],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.equal(result.skipReason, "rate_not_in_group_by");
    // Plan unchanged
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
    assert.equal(plan.aggregations[0]!.perDimension, undefined);
  });

  it("(e) skips when intent is null", () => {
    const step = planStep({
      plan: { groupBy: ["Cluster Name", "Date"], aggregations: [] },
    });
    const result = injectMultiPerIntent(step, null);
    assert.equal(result.skipReason, "no_intent");
  });

  it("(f) skips already-nested aggregations (idempotent)", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name", "Date"],
        aggregations: [
          {
            column: "Compliance Visit",
            operation: "mean",
            perDimension: "Day · Date",
            innerOperation: "sum",
          },
        ],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.equal(result.skipReason, "already_nested");
    // Plan unchanged (groupBy still has Date — but we don't strip it
    // when no rewrite happens; safer to leave the plan as-is)
    const plan = step.args.plan as { groupBy: string[] };
    assert.deepEqual(plan.groupBy, ["Cluster Name", "Date"]);
  });

  it("(g) skips when no aggregation matches the outer op (planner emitted SUM but intent is MEAN)", () => {
    const step = planStep({
      plan: {
        groupBy: ["Cluster Name", "Date"],
        aggregations: [{ column: "Compliance Visit", operation: "sum" }],
      },
    });
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.equal(result.skipReason, "no_matching_aggregation");
    // groupBy NOT mutated (safety: only commit groupBy change when we
    // also rewrite an aggregation)
    const plan = step.args.plan as { groupBy: string[] };
    assert.deepEqual(plan.groupBy, ["Cluster Name", "Date"]);
  });

  it("(h) non-execute_query_plan tools are ignored", () => {
    const step = planStep({ table: { rows: [] } }, "build_chart");
    const result = injectMultiPerIntent(step, MARICO_INTENT);
    assert.equal(result.skipReason, "not_execute_query_plan");
  });

  it("(i) supports SUM outer op for 'total X per day by region'", () => {
    const sumIntent: MultiPerIntent = {
      outerOp: "sum",
      rateDenominator: {
        column: "Day · Date",
        sourceColumn: "Date",
        grain: "date",
      },
      groupColumns: ["Region"],
      rawCaptures: ["day", "region"],
    };
    const step = planStep({
      plan: {
        groupBy: ["Region", "Date"],
        aggregations: [{ column: "Sales", operation: "sum" }],
      },
    });
    const result = injectMultiPerIntent(step, sumIntent);
    assert.deepEqual(result.rewrittenAggColumns, ["Sales"]);
    assert.deepEqual(result.removedFromGroupBy, ["Date"]);
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Region"]);
    assert.equal(plan.aggregations[0]!.perDimension, "Day · Date");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");
  });
});
