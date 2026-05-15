/**
 * Wave QL7 · `count_distinct` aggregation op + `computedAggregations` post-pass.
 *
 * Encodes the user's mental model: "average per day = total visits / number
 * of distinct days". Instead of the nested perDimension shape (which the
 * planner LLM frequently mis-emits as a 2D grid), the ratio shape is a
 * single GROUP BY with two aggregations + one computed ratio column:
 *
 *   groupBy: ["Cluster Name"],
 *   aggregations: [
 *     { column: "Compliance Visit", operation: "sum",            alias: "total_visits" },
 *     { column: "Date",             operation: "count_distinct", alias: "num_days"     },
 *   ],
 *   computedAggregations: [
 *     { alias: "avg_per_day", expression: "total_visits / num_days" },
 *   ]
 *
 * Result: ONE row per cluster with the daily average — exactly what the
 * Marico-VN user asked for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeQueryPlan,
  parseComputedAggregationExpression,
  queryPlanBodySchema,
} from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 12,
    columnCount: 3,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  };
}

function fixture(): Record<string, any>[] {
  // 2 clusters × 3 days × 2 visits-per-row = 12 rows total.
  // Cluster A: day 1 = 10+20, day 2 = 30+40, day 3 = 50+60 → totals 30, 70, 110 → SUM=210, distinct days=3 → avg=70
  // Cluster B: day 1 = 5+5,  day 2 = 5+15,  day 3 = 10+20  → totals 10, 20, 30  → SUM=60,  distinct days=3 → avg=20
  return [
    { "Cluster Name": "A", Date: "2026-04-01", "Compliance Visit": 10 },
    { "Cluster Name": "A", Date: "2026-04-01", "Compliance Visit": 20 },
    { "Cluster Name": "A", Date: "2026-04-02", "Compliance Visit": 30 },
    { "Cluster Name": "A", Date: "2026-04-02", "Compliance Visit": 40 },
    { "Cluster Name": "A", Date: "2026-04-03", "Compliance Visit": 50 },
    { "Cluster Name": "A", Date: "2026-04-03", "Compliance Visit": 60 },
    { "Cluster Name": "B", Date: "2026-04-01", "Compliance Visit": 5 },
    { "Cluster Name": "B", Date: "2026-04-01", "Compliance Visit": 5 },
    { "Cluster Name": "B", Date: "2026-04-02", "Compliance Visit": 5 },
    { "Cluster Name": "B", Date: "2026-04-02", "Compliance Visit": 15 },
    { "Cluster Name": "B", Date: "2026-04-03", "Compliance Visit": 10 },
    { "Cluster Name": "B", Date: "2026-04-03", "Compliance Visit": 20 },
  ];
}

describe("Wave QL7 · count_distinct aggregation operation", () => {
  it("queryPlanBodySchema accepts count_distinct op", () => {
    const parsed = queryPlanBodySchema.safeParse({
      aggregations: [
        { column: "Date", operation: "count_distinct", alias: "num_days" },
      ],
    });
    assert.equal(parsed.success, true);
  });

  it("queryPlanBodySchema accepts computedAggregations array", () => {
    const parsed = queryPlanBodySchema.safeParse({
      aggregations: [
        { column: "Compliance Visit", operation: "sum", alias: "total" },
        { column: "Date", operation: "count_distinct", alias: "num_days" },
      ],
      computedAggregations: [
        { alias: "avg_per_day", expression: "total / num_days" },
      ],
    });
    assert.equal(parsed.success, true);
  });

  it("queryPlanBodySchema rejects computedAggregations > 8 entries", () => {
    const big = Array.from({ length: 9 }, (_, i) => ({
      alias: `c${i}`,
      expression: "1 + 1",
    }));
    const parsed = queryPlanBodySchema.safeParse({
      computedAggregations: big,
    });
    assert.equal(parsed.success, false);
  });
});

describe("Wave QL7 · parseComputedAggregationExpression", () => {
  it("accepts simple arithmetic with alias identifiers", () => {
    const result = parseComputedAggregationExpression("total / num_days");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.aliasesReferenced.sort(), [
        "num_days",
        "total",
      ]);
    }
  });

  it("rejects SQL injection attempts", () => {
    const result = parseComputedAggregationExpression(
      "total / num_days; DROP TABLE data"
    );
    assert.equal(result.ok, false);
  });

  it("rejects reserved SQL keywords as identifiers", () => {
    const result = parseComputedAggregationExpression("SELECT total FROM x");
    assert.equal(result.ok, false);
  });

  it("rejects strings with quotes", () => {
    const result = parseComputedAggregationExpression(
      "total / 'malicious'"
    );
    assert.equal(result.ok, false);
  });

  it("accepts parens, multiplication, and floats", () => {
    const result = parseComputedAggregationExpression(
      "(total * 1.0) / (num_days + 0)"
    );
    assert.equal(result.ok, true);
  });
});

describe("Wave QL7 · in-memory executor ratio shape end-to-end", () => {
  it("produces ONE row per cluster with the daily average", () => {
    const result = executeQueryPlan(fixture(), summary(), {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Compliance Visit", operation: "sum", alias: "total_visits" },
        { column: "Date", operation: "count_distinct", alias: "num_days" },
      ],
      computedAggregations: [
        { alias: "avg_per_day", expression: "total_visits / num_days" },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.length, 2, "ONE row per cluster");
    const a = result.data.find((r: any) => r["Cluster Name"] === "A");
    const b = result.data.find((r: any) => r["Cluster Name"] === "B");
    assert.ok(a && b);
    assert.equal(a!.total_visits, 210);
    assert.equal(a!.num_days, 3);
    assert.equal(a!.avg_per_day, 70);
    assert.equal(b!.total_visits, 60);
    assert.equal(b!.num_days, 3);
    assert.equal(b!.avg_per_day, 20);
  });

  it("errors out when computedAggregations references an unknown alias", () => {
    const result = executeQueryPlan(fixture(), summary(), {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Compliance Visit", operation: "sum", alias: "total_visits" },
      ],
      computedAggregations: [
        { alias: "ratio", expression: "total_visits / nonexistent_alias" },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /identifier 'nonexistent_alias'/);
    }
  });

  it("count_distinct correctly counts unique non-null values per group", () => {
    const result = executeQueryPlan(fixture(), summary(), {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Date", operation: "count_distinct", alias: "num_days" },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.length, 2);
    for (const row of result.data) {
      assert.equal(row.num_days, 3, "each cluster has 3 distinct days");
    }
  });
});
