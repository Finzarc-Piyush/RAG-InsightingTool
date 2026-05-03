import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesceQueryPlanSteps } from "../lib/agents/runtime/coalescePlanSteps.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

function step(
  id: string,
  plan: Record<string, unknown>,
  extras: Partial<PlanStep> = {}
): PlanStep {
  return {
    id,
    tool: "execute_query_plan",
    args: { plan },
    ...extras,
  };
}

test("coalesce: identical groupBy + different aggs merge into one step", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }, { hypothesisId: "h1" }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }, { hypothesisId: "h2" }),
    step("s3", {
      groupBy: ["Category"],
      aggregations: [{ column: "Row ID", operation: "count" }],
    }, { hypothesisId: "h3" }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  const merged = out[0]!;
  assert.equal(merged.id, "s1");
  const aggs = (merged.args.plan as any).aggregations;
  assert.equal(aggs.length, 3);
  assert.deepEqual(
    aggs.map((a: any) => `${a.operation}(${a.column})`),
    ["sum(Sales)", "mean(Sales)", "count(Row ID)"]
  );
  assert.deepEqual(merged.hypothesisIds, ["h1", "h2", "h3"]);
});

test("coalesce: different groupBy stays separate", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
    step("s2", {
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 2);
});

test("coalesce: order-independent groupBy treats [A,B] === [B,A]", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category", "Region"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
    step("s2", {
      groupBy: ["Region", "Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.args.plan as any).aggregations.length, 2);
});

test("coalesce: different dimensionFilters stays separate", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      dimensionFilters: [{ column: "Region", op: "in", values: ["East"] }],
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      dimensionFilters: [{ column: "Region", op: "in", values: ["West"] }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 2);
});

test("coalesce: same dimensionFilters with reordered values still merge", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      dimensionFilters: [{ column: "Region", op: "in", values: ["East", "West"] }],
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
      dimensionFilters: [{ column: "Region", op: "in", values: ["West", "East"] }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.args.plan as any).aggregations.length, 2);
});

test("coalesce: cross-parallelGroup steps are NOT merged", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }, { parallelGroup: "g1" }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }, { parallelGroup: "g2" }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 2);
});

test("coalesce: same parallelGroup steps merge", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }, { parallelGroup: "g1" }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }, { parallelGroup: "g1" }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.parallelGroup, "g1");
});

test("coalesce: dependsOn steps are NEVER merged (preserve dependency)", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }, { dependsOn: "s1" }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 2);
});

test("coalesce: non-execute_query_plan steps are passed through", () => {
  const steps: PlanStep[] = [
    {
      id: "s1",
      tool: "build_chart",
      args: { type: "bar", x: "Category", y: "Sales" },
    },
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.tool, "build_chart");
});

test("coalesce: duplicate aggregations are de-duped by (column, operation, alias)", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.args.plan as any).aggregations.length, 1);
});

test("coalesce: empty list and single step are pass-through", () => {
  assert.deepEqual(coalesceQueryPlanSteps([]), []);
  const s: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }),
  ];
  assert.deepEqual(coalesceQueryPlanSteps(s), s);
});

test("coalesce: env gate disables merging when AGENT_COALESCE_SAME_SHAPE_QUERIES=false", () => {
  const prev = process.env.AGENT_COALESCE_SAME_SHAPE_QUERIES;
  process.env.AGENT_COALESCE_SAME_SHAPE_QUERIES = "false";
  try {
    const steps: PlanStep[] = [
      step("s1", {
        groupBy: ["Category"],
        aggregations: [{ column: "Sales", operation: "sum" }],
      }),
      step("s2", {
        groupBy: ["Category"],
        aggregations: [{ column: "Sales", operation: "mean" }],
      }),
    ];
    const out = coalesceQueryPlanSteps(steps);
    assert.equal(out.length, 2);
  } finally {
    if (prev === undefined) {
      delete process.env.AGENT_COALESCE_SAME_SHAPE_QUERIES;
    } else {
      process.env.AGENT_COALESCE_SAME_SHAPE_QUERIES = prev;
    }
  }
});

test("coalesce: hypothesisIds preserved without duplicates", () => {
  const steps: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    }, { hypothesisId: "h1" }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
    }, { hypothesisId: "h1" }), // same hypothesis
    step("s3", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "max" }],
    }, { hypothesisId: "h2" }),
  ];

  const out = coalesceQueryPlanSteps(steps);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.hypothesisIds, ["h1", "h2"]);
});

test("coalesce: different sort/limit stays separate", () => {
  const a: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      limit: 10,
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
      limit: 20,
    }),
  ];
  assert.equal(coalesceQueryPlanSteps(a).length, 2);

  const b: PlanStep[] = [
    step("s1", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      sort: [{ column: "Sales", direction: "desc" }],
    }),
    step("s2", {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "mean" }],
      sort: [{ column: "Sales", direction: "asc" }],
    }),
  ];
  assert.equal(coalesceQueryPlanSteps(b).length, 2);
});
