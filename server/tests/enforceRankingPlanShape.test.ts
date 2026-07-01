// RNK1 · Unit tests for `enforceRankingPlanShape` — the planner repair that
// coerces breakdown_ranking and execute_query_plan steps to the right
// leaderboard / extremum / entity-list shape based on a parsed RankingIntent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enforceRankingPlanShape,
  extractRankingIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import { EXTREMUM_LEADERBOARD_N } from "../lib/agents/runtime/planArgRepairs/ranking.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  columns: [
    { name: "Salesperson", type: "string", sampleValues: ["Alice"] },
    { name: "Product", type: "string", sampleValues: ["Hair Oil"] },
    { name: "Region", type: "string", sampleValues: ["North"] },
    { name: "Sales", type: "number", sampleValues: [100] },
    { name: "Leaves", type: "number", sampleValues: [3] },
  ],
  numericColumns: ["Sales", "Leaves"],
  dateColumns: [],
};

describe("RNK1 · enforceRankingPlanShape", () => {
  it("is a no-op when intent is null", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Region"] } },
    };
    const before = JSON.stringify(step.args);
    const result = enforceRankingPlanShape(step, null);
    assert.equal(result.changed, false);
    assert.equal(JSON.stringify(step.args), before);
  });

  it("is a no-op for tools outside the ranking set", () => {
    const intent = extractRankingIntent("top 50 salespeople by sales", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "build_chart",
      args: { type: "bar", x: "Region", y: "Sales" },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, false);
  });

  it("coerces breakdown_ranking topN up when LLM picked a smaller value", () => {
    const intent = extractRankingIntent("top 300 salespeople by sales", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: {
        breakdownColumn: "Region",
        metricColumn: "Sales",
        topN: 20,
      },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, true);
    assert.equal((step.args as any).topN, 300);
    // Entity column is overridden when LLM picked the wrong one.
    assert.equal((step.args as any).breakdownColumn, "Salesperson");
    assert.equal((step.args as any).metricColumn, "Sales");
    assert.equal((step.args as any).direction, "desc");
  });

  it("coerces breakdown_ranking direction to asc for 'lowest' intent", () => {
    const intent = extractRankingIntent("who has the lowest leaves", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: {
        breakdownColumn: "Salesperson",
        metricColumn: "Leaves",
        topN: 10,
      },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, true);
    // Extremum returns a leaderboard, not a single winner (RNK1 fix).
    assert.equal((step.args as any).topN, EXTREMUM_LEADERBOARD_N);
    assert.equal((step.args as any).direction, "asc");
  });

  it("coerces execute_query_plan to {groupBy: [entity], sort: [{metric_op desc}], limit: N}", () => {
    const intent = extractRankingIntent("top 300 salespeople by sales", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: { groupBy: ["Region"], aggregations: [{ column: "Sales", operation: "sum" }] },
      },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, true);
    const plan = (step.args as any).plan;
    assert.deepEqual(plan.groupBy, ["Salesperson", "Region"]);
    assert.equal(plan.aggregations.length, 1);
    assert.equal(plan.aggregations[0].column, "Sales");
    assert.equal(plan.aggregations[0].operation, "sum");
    assert.deepEqual(plan.sort, [{ column: "Sales_sum", direction: "desc" }]);
    assert.equal(plan.limit, 300);
  });

  it("coerces execute_query_plan extremum to {limit: leaderboard, op: 'max', sort: desc}", () => {
    const intent = extractRankingIntent("who has the maximum leaves", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: {} },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, true);
    const plan = (step.args as any).plan;
    assert.deepEqual(plan.groupBy, ["Salesperson"]);
    assert.equal(plan.aggregations[0].column, "Leaves");
    assert.equal(plan.aggregations[0].operation, "max");
    assert.deepEqual(plan.sort, [{ column: "Leaves_max", direction: "desc" }]);
    // Leaderboard, not a single argmax row (RNK1 fix).
    assert.equal(plan.limit, EXTREMUM_LEADERBOARD_N);
  });

  it("coerces execute_query_plan extremum-min to {op: 'min', sort: asc}", () => {
    const intent = extractRankingIntent("who has the lowest leaves", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: {} },
    };
    enforceRankingPlanShape(step, intent);
    const plan = (step.args as any).plan;
    assert.equal(plan.aggregations[0].operation, "min");
    assert.deepEqual(plan.sort, [{ column: "Leaves_min", direction: "asc" }]);
    assert.equal(plan.limit, EXTREMUM_LEADERBOARD_N);
  });

  it("PRESERVES a computed-metric ranking (ratio/gap) — never clobbers to a raw column, only lifts the row cap", () => {
    // The LLM built a deliberate computed ranking (a ratio sorted on its alias)
    // capped at LIMIT 1. Rewriting it to a raw single-column sum would rank by
    // the wrong measure — the worse bug. The repair must leave the shape intact
    // and only lift the single-row cap to the leaderboard size.
    const intent = extractRankingIntent("who has the highest sales", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "extremum");
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"], // deliberately NOT the intent entity — must stay
          aggregations: [
            { column: "Sales", operation: "sum", alias: "sales_sum" },
            { column: "Leaves", operation: "sum", alias: "leaves_sum" },
          ],
          computedAggregations: [
            { alias: "ratio", expression: "sales_sum / leaves_sum" },
          ],
          sort: [{ column: "ratio", direction: "desc" }],
          limit: 1,
        },
      },
    };
    const result = enforceRankingPlanShape(step, intent);
    const plan = (step.args as any).plan;
    // Shape preserved verbatim...
    assert.deepEqual(plan.groupBy, ["Region"]);
    assert.equal(plan.aggregations.length, 2);
    assert.deepEqual(plan.computedAggregations, [
      { alias: "ratio", expression: "sales_sum / leaves_sum" },
    ]);
    assert.deepEqual(plan.sort, [{ column: "ratio", direction: "desc" }]);
    // ...only the single-row cap is lifted.
    assert.equal(plan.limit, EXTREMUM_LEADERBOARD_N);
    assert.equal(result.changed, true);
  });

  it("leaves an unlimited computed ranking alone (already returns the full field)", () => {
    const intent = extractRankingIntent("who has the highest sales", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          computedAggregations: [{ alias: "ratio", expression: "a / b" }],
          sort: [{ column: "ratio", direction: "desc" }],
          // no limit → unlimited
        },
      },
    };
    enforceRankingPlanShape(step, intent);
    const plan = (step.args as any).plan;
    assert.equal(plan.limit, undefined);
    assert.deepEqual(plan.groupBy, ["Region"]);
  });

  it("rewrites entity-list intent to plain groupBy with no aggregations or limit", () => {
    const intent = extractRankingIntent("list the products", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          sort: [{ column: "Sales_sum", direction: "desc" }],
          limit: 100,
        },
      },
    };
    const result = enforceRankingPlanShape(step, intent);
    assert.equal(result.changed, true);
    const plan = (step.args as any).plan;
    assert.deepEqual(plan.groupBy, ["Product", "Region"]);
    assert.deepEqual(plan.aggregations, []);
    assert.equal(plan.sort, undefined);
    assert.equal(plan.limit, undefined);
  });

  it("preserves existing aggregation when its column already matches the intent metric", () => {
    const intent = extractRankingIntent("top 5 salespeople by sales", summary);
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Salesperson"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "TotalSales" }],
        },
      },
    };
    enforceRankingPlanShape(step, intent);
    const plan = (step.args as any).plan;
    // Existing alias is preserved (we only fill missing operation; we don't strip alias).
    assert.equal(plan.aggregations[0].alias, "TotalSales");
    assert.equal(plan.aggregations[0].operation, "sum");
  });
});
