import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeQueryPlan,
  remapQueryPlanGroupByToTemporalFacets,
} from "../lib/queryPlanExecutor.js";
import {
  applyTemporalFacetColumns,
  facetColumnKey,
} from "../lib/temporalFacetColumns.js";

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
});
