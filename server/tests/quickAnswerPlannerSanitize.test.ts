/**
 * Wave W-QL-FIX1 · Pins the Zod preprocess sanitizers that clean common
 * Mini-tier LLM output patterns before strict queryPlanBodySchema validates.
 *
 * Each test constructs the raw LLM JSON, passes it through the sanitizer,
 * and asserts the cleaned output either validates or preserves valid input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { queryPlanBodySchema } from "../lib/queryPlanExecutor.js";
import {
  sanitizeLlmPlan,
  sanitizeLlmResponse,
} from "../lib/agents/runtime/quickAnswerPlanner.js";

const planSchema = z.preprocess(sanitizeLlmPlan, queryPlanBodySchema);

const responseSchema = z.preprocess(
  sanitizeLlmResponse,
  z.object({
    plan: z.preprocess(sanitizeLlmPlan, queryPlanBodySchema),
    questionRestated: z.string().min(4).max(160),
  }),
);

describe("sanitizeLlmPlan", () => {
  it("coerces limit:null to undefined (plan validates)", () => {
    const raw = {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Compliance Visit", operation: "mean", alias: "avg_cv" },
      ],
      limit: null,
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.limit, undefined);
  });

  it("coerces limit:0 to undefined", () => {
    const raw = {
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      limit: 0,
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.limit, undefined);
  });

  it("strips unknown keys at plan level (steps, rationale, measure)", () => {
    const raw = {
      groupBy: ["Brand"],
      aggregations: [{ column: "Revenue", operation: "sum", alias: "total" }],
      steps: [{ tool: "execute_query_plan" }],
      rationale: "top brands by revenue",
      measure: "Revenue",
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.deepEqual(result.data.groupBy, ["Brand"]);
  });

  it("strips unknown keys inside aggregation entries", () => {
    const raw = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "sum",
          alias: "total_sales",
          measure: "Sales",
          description: "total sales per region",
        },
      ],
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    const agg = result.data.aggregations![0];
    assert.equal(agg.column, "Sales");
    assert.equal(agg.operation, "sum");
    assert.equal((agg as Record<string, unknown>).measure, undefined);
  });

  it("passes clean input through unchanged", () => {
    const raw = {
      groupBy: ["Category"],
      aggregations: [
        { column: "Units", operation: "count", alias: "unit_count" },
      ],
      sort: [{ column: "unit_count", direction: "desc" }],
      limit: 10,
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.limit, 10);
    assert.deepEqual(result.data.sort, [{ column: "unit_count", direction: "desc" }]);
  });

  it("coerces null on dateAggregationPeriod and dimensionFilters", () => {
    const raw = {
      groupBy: ["Month"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      dateAggregationPeriod: null,
      dimensionFilters: null,
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
  });

  it("preserves valid perDimension + innerOperation on aggregations", () => {
    const raw = {
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Cluster Name",
          innerOperation: "sum",
        },
      ],
    };
    const result = planSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    const agg = result.data.aggregations![0];
    assert.equal(agg.perDimension, "Cluster Name");
    assert.equal(agg.innerOperation, "sum");
  });
});

describe("sanitizeLlmResponse", () => {
  it("unwraps steps[0].args.plan into plan", () => {
    const raw = {
      steps: [
        {
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                { column: "Visits", operation: "mean", alias: "avg_visits" },
              ],
            },
          },
        },
      ],
      rationale: "Average visits per cluster",
    };
    const result = responseSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.deepEqual(result.data.plan.groupBy, ["Cluster Name"]);
    assert.equal(result.data.questionRestated, "Average visits per cluster");
  });

  it("leaves correct {plan, questionRestated} shape untouched", () => {
    const raw = {
      plan: {
        groupBy: ["Region"],
        aggregations: [{ column: "Sales", operation: "sum" }],
      },
      questionRestated: "Total sales by region",
    };
    const result = responseSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.questionRestated, "Total sales by region");
  });

  it("uses questionRestated over rationale when both present on steps shape", () => {
    const raw = {
      steps: [
        {
          args: {
            plan: {
              groupBy: ["X"],
              aggregations: [{ column: "Y", operation: "count" }],
            },
          },
        },
      ],
      questionRestated: "Count Y per X",
      rationale: "fallback",
    };
    const result = responseSchema.safeParse(raw);
    assert.ok(result.success, `Expected success: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.questionRestated, "Count Y per X");
  });
});
