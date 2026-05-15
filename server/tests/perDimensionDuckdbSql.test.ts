/**
 * Wave PD1 · DuckDB SQL builder emits a derived-table subquery when
 * aggregations have `perDimension`. Inner SELECT buckets by (groupBy ∪
 * perDim) with `innerOperation` (default sum); outer SELECT applies the
 * outer `operation` across bucket totals. Pins the SQL shape, alias
 * generation, dimensionFilter placement, and the mixed-plan rejection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryPlanDuckdbSql,
  canExecuteQueryPlanOnDuckDb,
  aggregationsHaveNested,
  aggregationsPerDimensionsInPlan,
} from "../lib/queryPlanDuckdbExecutor.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

describe("Wave PD1 · DuckDB SQL builder — nested aggregation", () => {
  it("builds a derived-table subquery for mean-per-day plan (Marico screenshot scenario)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built, "plan should build");
    const sql = built!.aggregateSql;
    // Outer SELECT applies AVG across bucket totals
    assert.match(sql, /SELECT[\s\S]+AVG\("__unit_total_0__"\)/);
    // Inner subquery sums the metric per (Cluster Name, day bucket)
    assert.match(sql, /SUM\(TRY_CAST\("Compliance Visit" AS DOUBLE\)\)/);
    // perDimension bucket
    assert.match(sql, /AS "__pd_bucket__"/);
    // Outer GROUP BY ONLY by the user's groupBy column (not the bucket)
    assert.match(sql, /\) sub GROUP BY "Cluster Name"/);
    // Inner GROUP BY contains both
    assert.match(sql, /GROUP BY "Cluster Name", "Day · TSOE-Date Combo"/);
    // Outer alias is the auto-generated `_per_` shape
    assert.match(
      sql,
      /AS "Compliance Visit_mean_per_Day_TSOE_Date_Combo"/
    );
  });

  it("defaults innerOperation to sum when omitted", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
        },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built);
    assert.match(built!.aggregateSql, /SUM\(TRY_CAST\("Sales" AS DOUBLE\)\)/);
  });

  it("places plan.dimensionFilters on the INNER subquery (filter raw rows before bucketing)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
          innerOperation: "sum",
        },
      ],
      dimensionFilters: [
        { column: "Region", op: "in", values: ["West"] },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built);
    const sql = built!.aggregateSql;
    // The WHERE clause must appear INSIDE the subquery (before "sub" closer)
    const innerEnd = sql.indexOf(") sub");
    assert.ok(innerEnd > -1, "expected derived-table subquery shape");
    const innerSql = sql.slice(0, innerEnd);
    assert.match(innerSql, /WHERE\b/);
    // The filter compiler may emit TRIM/CAST wrappers around the column ref;
    // assert by the literal value side which is stable.
    assert.match(innerSql, /'West'/);
    assert.match(innerSql, /"Region"/);
    // And NOT after the closing of the subquery
    const outerSql = sql.slice(innerEnd);
    assert.doesNotMatch(outerSql, /'West'/);
  });

  it("supports sum-per-customer (non-temporal perDimension)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "sum",
          perDimension: "Customer",
          innerOperation: "sum",
        },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built);
    assert.match(built!.aggregateSql, /SUM\("__unit_total_0__"\)/);
    assert.match(built!.aggregateSql, /AS "Sales_sum_per_Customer"/);
  });

  it("supports max-per-region (outer MAX over bucket totals)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "max",
          perDimension: "Region",
          innerOperation: "sum",
        },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built);
    assert.match(built!.aggregateSql, /MAX\("__unit_total_0__"\)/);
  });

  it("rejects mixed plans — some aggregations have perDimension, others don't", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
          innerOperation: "sum",
        },
        { column: "Visits", operation: "sum" },
      ],
    };
    assert.equal(
      canExecuteQueryPlanOnDuckDb(plan),
      false,
      "mixed flat + nested plans are unsupported in v1"
    );
  });

  it("rejects plans with multiple distinct perDimensions", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
          innerOperation: "sum",
        },
        {
          column: "Visits",
          operation: "mean",
          perDimension: "Customer",
          innerOperation: "sum",
        },
      ],
    };
    assert.equal(canExecuteQueryPlanOnDuckDb(plan), false);
  });

  it("Key Insight text describes the nested aggregation in natural language", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built);
    const desc = built!.descriptions[built!.descriptions.length - 1]!;
    // Reads "Average daily Compliance Visit by Cluster Name" (or similar)
    assert.match(desc, /Average daily Compliance Visit/);
    assert.match(desc, /by Cluster Name/);
  });

  it("helpers aggregationsHaveNested / aggregationsPerDimensionsInPlan reflect plan shape", () => {
    const nested: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
        },
      ],
    };
    assert.equal(aggregationsHaveNested(nested), true);
    assert.deepEqual([...aggregationsPerDimensionsInPlan(nested)], [
      "Day · OrderDate",
    ]);
    const flat: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    assert.equal(aggregationsHaveNested(flat), false);
    assert.equal(aggregationsPerDimensionsInPlan(flat).size, 0);
  });
});
