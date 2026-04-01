import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearRedundantDateAggregationForTemporalFacets,
  executeQueryPlan,
  remapQueryPlanGroupByToTemporalFacets,
} from "../lib/queryPlanExecutor.js";
import {
  applyTemporalFacetColumns,
  facetColumnKey,
} from "../lib/temporalFacetColumns.js";

describe("clearRedundantDateAggregationForTemporalFacets", () => {
  it("strips dateAggregationPeriod when groupBy is matching __tf_month__ facet (user bug shape)", () => {
    const plan = {
      groupBy: ["__tf_month__Order_Date"],
      dateAggregationPeriod: "month" as const,
      aggregations: [
        { column: "Sales", operation: "sum" as const, alias: "Total_Sales" },
      ],
    };
    const cleared = clearRedundantDateAggregationForTemporalFacets(plan);
    assert.equal(cleared.dateAggregationPeriod, undefined);
    assert.deepEqual(cleared.groupBy, ["__tf_month__Order_Date"]);
  });
});

describe("remapQueryPlanGroupByToTemporalFacets + execute_query_plan", () => {
  it("month intent remaps groupBy to __tf_month__* when that key exists", () => {
    const data: Record<string, unknown>[] = [
      { "Order Date": "2015-06-15", Sales: 10 },
      { "Order Date": "2015-07-01", Sales: 20 },
    ];
    applyTemporalFacetColumns(data as Record<string, any>[], ["Order Date"]);
    const monthKey = facetColumnKey("Order Date", "month");
    const keys = new Set(Object.keys(data[0]!));
    assert.ok(keys.has(monthKey));

    const summary = {
      rowCount: 2,
      columnCount: keys.size,
      columns: [...keys].map((name) => ({
        name,
        type: "string",
        sampleValues: [] as (string | number | null)[],
      })),
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };

    const plan = {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month" as const,
      aggregations: [{ column: "Sales", operation: "sum" as const }],
    };

    const remapped = remapQueryPlanGroupByToTemporalFacets(
      plan,
      summary,
      keys,
      "what about by month?"
    );
    assert.deepEqual(remapped.groupBy, [monthKey]);
    assert.equal(remapped.dateAggregationPeriod, undefined);

    const exec = executeQueryPlan(data as Record<string, any>[], summary, remapped);
    assert.equal(exec.ok, true);
    if (exec.ok) {
      assert.ok(exec.data.length >= 1);
    }
  });

  it("execute_query_plan uses facet values when plan sets dateAggregationPeriod with __tf_month groupBy", () => {
    const data: Record<string, unknown>[] = [
      { Region: "West", Sales: 10, __tf_month__Order_Date: "2015-06" },
      { Region: "West", Sales: 5, __tf_month__Order_Date: "2015-07" },
      { Region: "East", Sales: 3, __tf_month__Order_Date: "2015-06" },
    ];
    const keys = new Set(Object.keys(data[0]!));
    const summary = {
      rowCount: 3,
      columnCount: keys.size,
      columns: [...keys].map((name) => ({
        name,
        type: "string",
        sampleValues: [] as (string | number | null)[],
      })),
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    const monthKey = "__tf_month__Order_Date";
    const plan = {
      groupBy: [monthKey, "Region"],
      dateAggregationPeriod: "month" as const,
      aggregations: [{ column: "Sales", operation: "sum" as const, alias: "s" }],
    };
    const exec = executeQueryPlan(data as Record<string, any>[], summary, plan);
    assert.equal(exec.ok, true);
    if (exec.ok) {
      assert.equal(exec.data.length, 3);
      assert.ok(!exec.data.some((r) => String(r[monthKey]) === "undefined"));
    }
  });
});
