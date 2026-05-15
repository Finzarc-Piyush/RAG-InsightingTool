/**
 * Wave PD1 · End-to-end pipeline test: detect → inject → build SQL.
 *
 * Mirrors the failing scenario from the Marico screenshot: a question that
 * pre-PD1 emitted single-pass `mean(Compliance Visit) GROUP BY Cluster`
 * (averaging raw per-employee-per-day rows, returning 21K/15K nonsense).
 * After PD1: detector picks up "per day" intent, injector rewrites the
 * plan to nested-aggregation shape, SQL builder emits the derived-table
 * subquery, Key Insight text reads "Average daily X by Cluster Name".
 *
 * Also pins the negative side: plans the planner already decomposed
 * correctly (groupBy includes the day facet) are left alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectPerXIntent,
  injectPerDimensionForRateIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

const MARICO_SUMMARY: Pick<DataSummary, "columns" | "dateColumns"> = {
  columns: [
    { name: "Compliance Visit", type: "number", sampleValues: [] },
    { name: "Cluster Name", type: "string", sampleValues: [] },
    { name: "TSOE-Date Combo", type: "date", sampleValues: [] },
  ],
  dateColumns: ["TSOE-Date Combo"],
};

describe("Wave PD1 · pipeline (detect → inject → SQL)", () => {
  it("Marico screenshot: 'average compliance visits per day across clusters' yields nested SQL", () => {
    // 1. Intent detection
    const intent = detectPerXIntent(
      "What is the average number of compliance visits per day across clusters?",
      MARICO_SUMMARY as DataSummary
    );
    assert.ok(intent, "intent must be detected");
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.perDimension, "Day · TSOE-Date Combo");

    // 2. Planner emitted the broken single-pass plan (the bug)
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Cluster Name"],
          aggregations: [
            { column: "Compliance Visit", operation: "mean" },
          ],
        },
      },
    } as PlanStep;

    // 3. PD1 injector rewrites the plan in place
    const repair = injectPerDimensionForRateIntent(step, intent);
    assert.deepEqual(repair.rewrittenAggColumns, ["Compliance Visit"]);

    // 4. The rewritten plan now has perDimension + innerOperation
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
    assert.equal(plan.aggregations[0]!.column, "Compliance Visit");
    assert.equal(plan.aggregations[0]!.operation, "mean");
    assert.equal(plan.aggregations[0]!.perDimension, "Day · TSOE-Date Combo");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");

    // 5. SQL builder emits a derived-table subquery
    const built = buildQueryPlanDuckdbSql(plan as never);
    assert.ok(built, "rewritten plan should build SQL");
    const sql = built!.aggregateSql;
    // Outer: AVG across bucket totals
    assert.match(sql, /AVG\("__unit_total_0__"\)/);
    // Inner: SUM raw column per (Cluster Name, day bucket)
    assert.match(sql, /SUM\(TRY_CAST\("Compliance Visit" AS DOUBLE\)\)/);
    // Inner bucketing column
    assert.match(sql, /"Day · TSOE-Date Combo" AS "__pd_bucket__"/);
    // Outer GROUP BY just the user's groupBy column (the bucket is NOT in
    // the outer group — it's collapsed by the outer aggregator)
    assert.match(sql, /\) sub GROUP BY "Cluster Name"/);
    // Inner GROUP BY contains both
    assert.match(sql, /GROUP BY "Cluster Name", "Day · TSOE-Date Combo"/);

    // 6. Key Insight text describes the operation in natural language
    const desc = built!.descriptions[built!.descriptions.length - 1]!;
    assert.match(desc, /Average daily Compliance Visit by Cluster Name/);
  });

  it("planner-correct decomposition (groupBy includes Day facet) is NOT rewritten", () => {
    const intent = detectPerXIntent(
      "Average compliance visits per day by cluster",
      MARICO_SUMMARY as DataSummary
    );
    assert.ok(intent);

    // The planner LLM already decomposed: groupBy=[Cluster, Day·X] with sum
    // gives the per-day breakdown directly. PD1 must NOT rewrite this —
    // it's a valid (different) interpretation: a trend / breakdown.
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Cluster Name", "Day · TSOE-Date Combo"],
          aggregations: [
            { column: "Compliance Visit", operation: "sum" },
          ],
        },
      },
    } as PlanStep;
    const repair = injectPerDimensionForRateIntent(step, intent);
    assert.equal(repair.rewrittenAggColumns.length, 0);
    assert.equal(repair.skipReason, "already_in_group_by");

    // Plan unchanged
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Cluster Name", "Day · TSOE-Date Combo"]);
    assert.equal(plan.aggregations[0]!.perDimension, undefined);
  });

  it("non-rate question ('sales by region') flows through unchanged", () => {
    const intent = detectPerXIntent(
      "Show me sales by region",
      MARICO_SUMMARY as DataSummary
    );
    assert.equal(intent, null);

    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Cluster Name"],
          aggregations: [{ column: "Compliance Visit", operation: "sum" }],
        },
      },
    } as PlanStep;
    const repair = injectPerDimensionForRateIntent(step, intent);
    assert.equal(repair.skipReason, "no_intent");
    const plan = step.args.plan as {
      aggregations: Array<Record<string, unknown>>;
    };
    assert.equal(plan.aggregations[0]!.perDimension, undefined);

    // SQL builder still produces the single-pass flat aggregation
    const built = buildQueryPlanDuckdbSql(plan as never);
    assert.ok(built);
    // The outer SELECT shape — no derived-table subquery
    assert.doesNotMatch(built!.aggregateSql, /__unit_total_0__/);
    assert.doesNotMatch(built!.aggregateSql, /__pd_bucket__/);
  });
});
