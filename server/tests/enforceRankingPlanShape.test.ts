// RNK1 · Unit tests for `enforceRankingPlanShape` — the planner repair that
// coerces breakdown_ranking and execute_query_plan steps to the right
// leaderboard / extremum / entity-list shape based on a parsed RankingIntent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enforceRankingPlanShape,
  extractRankingIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
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
    assert.equal((step.args as any).topN, 1);
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

  it("coerces execute_query_plan extremum to {limit: 1, op: 'max', sort: desc}", () => {
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
    assert.equal(plan.limit, 1);
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
    assert.equal(plan.limit, 1);
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
