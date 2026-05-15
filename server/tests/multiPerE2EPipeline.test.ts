/**
 * Wave PD3 · End-to-end pipeline test for the Marico failing scenario:
 *
 *   Question: "What is the average number of compliance visits per day per cluster"
 *   Planner emits: groupBy=[Cluster Name, Date], aggregations=[{ col: "Compliance Visit", op: "mean" }]
 *   PD3 detects multi-per intent → rewrites plan
 *   Final plan: groupBy=[Cluster Name], aggregations=[{ col, op: "mean", perDim: "Day · Date", innerOp: "sum" }]
 *   SQL builder emits: derived-table subquery with AVG(SUM(visits) per day) per cluster
 *   Key Insight: "Average daily Compliance Visit by Cluster Name"
 *
 * This pins the full chain DETECT → INJECT → SQL together.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectMultiPerIntent,
  injectMultiPerIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

const MARICO_SUMMARY: Pick<DataSummary, "columns" | "dateColumns"> = {
  columns: [
    { name: "Compliance Visit", type: "number", sampleValues: [] },
    { name: "Cluster Name", type: "string", sampleValues: [] },
    { name: "Date", type: "date", sampleValues: [] },
  ],
  dateColumns: ["Date"],
};

describe("Wave PD3 · Marico failing scenario — full pipeline", () => {
  it("'average compliance visits per day per cluster' → rate-per-cluster SQL", () => {
    // 1. Detect multi-per intent
    const intent = detectMultiPerIntent(
      "What is the average number of compliance visits per day per cluster",
      MARICO_SUMMARY as DataSummary
    );
    assert.ok(intent, "multi-per intent must be detected");
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.deepEqual(intent!.groupColumns, ["Cluster Name"]);

    // 2. Planner emits the broken trend-with-breakdown plan
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
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
      },
    } as PlanStep;

    // 3. PD3 injector rewrites in place
    const repair = injectMultiPerIntent(step, intent);
    assert.deepEqual(repair.rewrittenAggColumns, ["Compliance Visit"]);
    assert.deepEqual(repair.removedFromGroupBy, ["Date"]);

    // 4. Plan now has the correct rate-per-cluster shape
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
    assert.equal(plan.aggregations[0]!.column, "Compliance Visit");
    assert.equal(plan.aggregations[0]!.operation, "mean");
    assert.equal(plan.aggregations[0]!.perDimension, "Day · Date");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");

    // 5. SQL builder emits the derived-table subquery
    const built = buildQueryPlanDuckdbSql(plan as never);
    assert.ok(built, "rewritten plan should build SQL");
    const sql = built!.aggregateSql;
    // Outer: AVG of bucket totals
    assert.match(sql, /AVG\("__unit_total_0__"\)/);
    // Inner: SUM raw column per (Cluster Name, day bucket)
    assert.match(sql, /SUM\(TRY_CAST\("Compliance Visit" AS DOUBLE\)\)/);
    // perDim bucket
    assert.match(sql, /"Day · Date" AS "__pd_bucket__"/);
    // Outer GROUP BY ONLY Cluster Name (Date moved out)
    assert.match(sql, /\) sub GROUP BY "Cluster Name"/);
    // Inner GROUP BY contains BOTH Cluster Name AND Day · Date
    assert.match(sql, /GROUP BY "Cluster Name", "Day · Date"/);
    // Outer alias preserved (user-supplied)
    assert.match(sql, /AS "average_compliance_visits_per_day"/);

    // 6. Key Insight text
    const desc = built!.descriptions[built!.descriptions.length - 1]!;
    assert.match(desc, /Average daily Compliance Visit by Cluster Name/);
  });

  it("'daily average sales by region' → adverbial form, same shape", () => {
    const summaryWithSalesAndRegion: Pick<DataSummary, "columns" | "dateColumns"> = {
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Date", type: "date", sampleValues: [] },
      ],
      dateColumns: ["Date"],
    };
    const intent = detectMultiPerIntent(
      "Daily average sales by region",
      summaryWithSalesAndRegion as DataSummary
    );
    assert.ok(intent);
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.deepEqual(intent!.groupColumns, ["Region"]);

    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region", "Date"],
          aggregations: [{ column: "Sales", operation: "mean" }],
        },
      },
    } as PlanStep;
    const repair = injectMultiPerIntent(step, intent);
    assert.deepEqual(repair.rewrittenAggColumns, ["Sales"]);
    const plan = step.args.plan as {
      groupBy: string[];
      aggregations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(plan.groupBy, ["Region"]);
    assert.equal(plan.aggregations[0]!.perDimension, "Day · Date");
  });

  it("when planner emits the CORRECT shape, PD3 leaves it alone (rate_not_in_group_by)", () => {
    // Planner correctly emits groupBy=[Cluster Name] only.
    const intent = detectMultiPerIntent(
      "average compliance visits per day per cluster",
      MARICO_SUMMARY as DataSummary
    );
    assert.ok(intent);
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
    const repair = injectMultiPerIntent(step, intent);
    assert.equal(repair.skipReason, "rate_not_in_group_by");
    // PD1's single-per injector will pick this up downstream and add
    // perDimension. PD3 doesn't second-guess that.
  });

  it("when planner emits the FULLY CORRECT nested shape, PD3 also leaves it alone (already_nested)", () => {
    const intent = detectMultiPerIntent(
      "average compliance visits per day per cluster",
      MARICO_SUMMARY as DataSummary
    );
    assert.ok(intent);
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
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
      },
    } as PlanStep;
    const repair = injectMultiPerIntent(step, intent);
    assert.equal(repair.skipReason, "already_nested");
  });
});
