// RNK1 · Unit tests for `liftSingleRowRankingFloor` — the deterministic
// backstop that lifts an LLM-emitted single-row ranking (LIMIT 1 / topN 1) on a
// superlative "which/who X is highest/largest/…" question up to a leaderboard,
// WITHOUT rewriting the metric / sort / groupBy / computedAggregations. This is
// what fixes the "no other <entity> result is present … a ranking cannot be
// completed" hedge for the "which channel…" / "which brand code…" phrasings that
// the narrower `extractRankingIntent` ("who has …" only) never catches.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liftSingleRowRankingFloor } from "../lib/agents/runtime/planArgRepairs.js";
import { EXTREMUM_LEADERBOARD_N } from "../lib/agents/runtime/planArgRepairs/ranking.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

describe("RNK1 · liftSingleRowRankingFloor", () => {
  it("lifts a computed-ratio execute_query_plan LIMIT 1 to a leaderboard and preserves the shape", () => {
    // "Which channel shows the highest GST burden relative to Net Sales?" — a
    // ratio the planner correctly put in computedAggregations, then capped at 1.
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Channel"],
          aggregations: [
            { column: "GST", operation: "sum", alias: "gst_sum" },
            { column: "Net_Sales", operation: "sum", alias: "ns_sum" },
          ],
          computedAggregations: [
            { alias: "gst_burden", expression: "gst_sum / ns_sum" },
          ],
          sort: [{ column: "gst_burden", direction: "desc" }],
          limit: 1,
        },
      },
    };
    const result = liftSingleRowRankingFloor(
      step,
      "Which channel shows the highest GST burden relative to Net Sales?"
    );
    assert.equal(result.changed, true);
    const plan = (step.args as any).plan;
    // Only the row cap moved...
    assert.equal(plan.limit, EXTREMUM_LEADERBOARD_N);
    // ...everything else is byte-for-byte the planner's ratio ranking.
    assert.deepEqual(plan.groupBy, ["Channel"]);
    assert.equal(plan.aggregations.length, 2);
    assert.deepEqual(plan.computedAggregations, [
      { alias: "gst_burden", expression: "gst_sum / ns_sum" },
    ]);
    assert.deepEqual(plan.sort, [{ column: "gst_burden", direction: "desc" }]);
  });

  it("lifts a breakdown_ranking topN 1 on a superlative question", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: { breakdownColumn: "Brand_Code", metricColumn: "Gap", topN: 1 },
    };
    const result = liftSingleRowRankingFloor(
      step,
      "Which brand code has the largest gap between MRP Value and NR?"
    );
    assert.equal(result.changed, true);
    assert.equal((step.args as any).topN, EXTREMUM_LEADERBOARD_N);
  });

  it("is a no-op for growth questions (they route to compute_growth)", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Brand"],
          sort: [{ column: "growth", direction: "desc" }],
          limit: 1,
        },
      },
    };
    const before = JSON.stringify(step.args);
    // TREND_INTENT_RE (the query-intent authority's growth vocabulary) matches
    // "growth" — such questions route to compute_growth, so the floor stays out.
    const result = liftSingleRowRankingFloor(step, "which brand had the highest growth this year");
    assert.equal(result.changed, false);
    assert.equal(JSON.stringify(step.args), before);
  });

  it("is a no-op when the plan is not a grouped ranking (no groupBy / no sort)", () => {
    const scalar: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { aggregations: [{ column: "Sales", operation: "sum" }], limit: 1 } },
    };
    assert.equal(
      liftSingleRowRankingFloor(scalar, "which region has the highest sales").changed,
      false
    );
  });

  it("never reduces a deliberately larger limit", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Channel"],
          sort: [{ column: "x", direction: "desc" }],
          limit: 25,
        },
      },
    };
    const result = liftSingleRowRankingFloor(step, "which channel has the highest x");
    assert.equal(result.changed, false);
    assert.equal((step.args as any).plan.limit, 25);
  });

  it("is a no-op for non-superlative questions", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: { groupBy: ["Channel"], sort: [{ column: "x", direction: "desc" }], limit: 1 },
      },
    };
    assert.equal(
      liftSingleRowRankingFloor(step, "show sales by channel").changed,
      false
    );
  });

  it("is a no-op for tools outside the ranking set", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "build_chart",
      args: { type: "bar", x: "Channel", y: "Sales" },
    };
    assert.equal(
      liftSingleRowRankingFloor(step, "which channel has the highest sales").changed,
      false
    );
  });
});
