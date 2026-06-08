/**
 * Fix C · repairBooleanIndicatorRatePlan — fail-forward rebind of an invalid
 * `<x>_rate` aggregation ref to a countIf-ratio over a token-matching boolean
 * indicator. This is what stops "build dashboard for PJP Adherence" aborting
 * with invalid_column_ref:adherence_rate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairBooleanIndicatorRatePlan } from "../lib/agents/runtime/booleanIndicatorRateRepair.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function summaryWithBooleanIndicator(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 3,
    columns: [
      { name: "Cluster Name", type: "string" },
      { name: "Compliance Visit", type: "number" },
      {
        name: "PJP Adherence",
        type: "string",
        indicator: {
          kind: "boolean",
          positiveValues: ["TRUE"],
          negativeValues: ["FALSE"],
          sentinelValues: ["Absent"],
          source: "auto",
        },
      },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: [],
  } as unknown as DataSummary;
}

describe("repairBooleanIndicatorRatePlan", () => {
  it("rebinds an invalid `adherence_rate` aggregation to a countIf-ratio over PJP Adherence", () => {
    const plan = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "adherence_rate", operation: "avg" }],
    } as unknown as QueryPlanBody;

    const { plan: out, repaired } = repairBooleanIndicatorRatePlan(plan, summaryWithBooleanIndicator());
    assert.equal(repaired, true);
    const aggs = (out.aggregations ?? []) as Array<Record<string, any>>;
    // adherence_rate aggregation replaced by two countIf aggregations.
    assert.equal(aggs.length, 2);
    assert.ok(aggs.every((a) => a.operation === "countIf" && a.column === "*"));
    const matching = aggs.find((a) => a.alias?.endsWith("__matching"));
    const total = aggs.find((a) => a.alias?.endsWith("__total"));
    assert.ok(matching && total, "matching + total countIf aggregations present");
    assert.deepEqual(matching!.predicate[0], { column: "PJP Adherence", op: "in", values: ["TRUE"] });
    // total denominator = positives ∪ negatives, sentinel excluded.
    assert.deepEqual(total!.predicate[0], { column: "PJP Adherence", op: "in", values: ["TRUE", "FALSE"] });
    // computed ratio keeps the name the planner referenced, so sort/downstream resolve.
    const computed = (out.computedAggregations ?? []) as Array<Record<string, any>>;
    assert.ok(computed.some((c) => c.alias === "adherence_rate" && /__matching \/ .*__total/.test(c.expression)));
    // groupBy preserved → per-cluster rate.
    assert.deepEqual(out.groupBy, ["Cluster Name"]);
  });

  it("leaves a valid plan untouched (column exists in schema)", () => {
    const plan = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "sum" }],
    } as unknown as QueryPlanBody;
    const { repaired } = repairBooleanIndicatorRatePlan(plan, summaryWithBooleanIndicator());
    assert.equal(repaired, false);
  });

  it("does not rebind when the invalid column matches no boolean indicator", () => {
    const plan = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "revenue_growth", operation: "avg" }],
    } as unknown as QueryPlanBody;
    const { repaired } = repairBooleanIndicatorRatePlan(plan, summaryWithBooleanIndicator());
    assert.equal(repaired, false);
  });

  it("does not rebind a boolean indicator that lacks positive values (can't build a correct predicate)", () => {
    const summary = {
      rowCount: 10,
      columnCount: 1,
      columns: [
        { name: "PJP Adherence", type: "string", indicator: { kind: "boolean", source: "auto" } },
      ],
      numericColumns: [],
      dateColumns: [],
    } as unknown as DataSummary;
    const plan = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "adherence_rate", operation: "avg" }],
    } as unknown as QueryPlanBody;
    const { repaired } = repairBooleanIndicatorRatePlan(plan, summary);
    assert.equal(repaired, false);
  });
});
