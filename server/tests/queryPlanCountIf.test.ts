import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queryPlanBodySchema,
  executeQueryPlan,
  type QueryPlanBody,
} from "../lib/queryPlanExecutor.js";
import {
  buildQueryPlanDuckdbSql,
  canExecuteQueryPlanOnDuckDb,
} from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  columns: [
    { name: "Clock-In <09:30", type: "text", uniqueValues: 3 },
    { name: "Cluster Name", type: "text", uniqueValues: 5 },
    { name: "Total Visited OL's", type: "numeric", uniqueValues: 50 },
  ],
  numericColumns: ["Total Visited OL's"],
  dateColumns: [],
  totalRows: 0,
  sampleRows: [],
};

describe("Wave PCT1 · countIf / sumIf aggregation with predicate", () => {
  describe("schema", () => {
    it("accepts countIf with a non-empty predicate", () => {
      const parsed = queryPlanBodySchema.safeParse({
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
        ],
      });
      assert.equal(parsed.success, true);
    });

    it("accepts sumIf with a non-empty predicate", () => {
      const parsed = queryPlanBodySchema.safeParse({
        aggregations: [
          {
            column: "Total Visited OL's",
            operation: "sumIf",
            alias: "premium_revenue",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
        ],
      });
      assert.equal(parsed.success, true);
    });

    it("rejects countIf without a predicate", () => {
      const parsed = queryPlanBodySchema.safeParse({
        aggregations: [{ column: "*", operation: "countIf" }],
      });
      assert.equal(parsed.success, false);
    });

    it("rejects sumIf with empty predicate array", () => {
      const parsed = queryPlanBodySchema.safeParse({
        aggregations: [
          { column: "Total Visited OL's", operation: "sumIf", predicate: [] },
        ],
      });
      assert.equal(parsed.success, false);
    });

    it("non-conditional ops still pass without a predicate", () => {
      const parsed = queryPlanBodySchema.safeParse({
        aggregations: [{ column: "Total Visited OL's", operation: "sum" }],
      });
      assert.equal(parsed.success, true);
    });
  });

  describe("DuckDB SQL builder", () => {
    it("compiles countIf into COUNT(CASE WHEN <predicate> THEN 1 END)", () => {
      const plan: QueryPlanBody = {
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
          { column: "*", operation: "count", alias: "total" },
        ],
      };
      assert.equal(canExecuteQueryPlanOnDuckDb(plan), true);
      const built = buildQueryPlanDuckdbSql(plan);
      assert.ok(built, "plan must compile");
      assert.match(
        built!.aggregateSql,
        /COUNT\(CASE WHEN .*"Clock-In <09:30".* IN \('Yes'\).* THEN 1 END\) AS "matching"/,
        "matching alias must be a CASE-WHEN COUNT"
      );
      assert.match(
        built!.aggregateSql,
        /COUNT\(\*\) AS "total"/,
        "total alias must be COUNT(*)"
      );
    });

    it("compiles sumIf into SUM(CASE WHEN <predicate> THEN col END)", () => {
      const plan: QueryPlanBody = {
        aggregations: [
          {
            column: "Total Visited OL's",
            operation: "sumIf",
            alias: "premium",
            predicate: [
              { column: "Cluster Name", op: "in", values: ["North"] },
            ],
          },
          {
            column: "Total Visited OL's",
            operation: "sum",
            alias: "total",
          },
        ],
      };
      const built = buildQueryPlanDuckdbSql(plan);
      assert.ok(built);
      assert.match(
        built!.aggregateSql,
        /SUM\(CASE WHEN .*"Cluster Name".* THEN TRY_CAST\("Total Visited OL's" AS DOUBLE\) END\) AS "premium"/,
      );
    });

    it("ANDs multi-entry predicates inside the CASE WHEN", () => {
      const plan: QueryPlanBody = {
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
              { column: "Cluster Name", op: "in", values: ["North", "South"] },
            ],
          },
        ],
      };
      const built = buildQueryPlanDuckdbSql(plan);
      assert.ok(built);
      // Two predicate clauses joined by AND, wrapped in parens.
      assert.match(
        built!.aggregateSql,
        /CASE WHEN \(.*"Clock-In <09:30".* AND .*"Cluster Name".* IN \('North', 'South'\)\) THEN 1 END/,
      );
    });

    it("supports countIf alongside groupBy", () => {
      const plan: QueryPlanBody = {
        groupBy: ["Cluster Name"],
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
          { column: "*", operation: "count", alias: "total" },
        ],
      };
      const built = buildQueryPlanDuckdbSql(plan);
      assert.ok(built);
      assert.match(built!.aggregateSql, /GROUP BY "Cluster Name"/);
    });

    it("escapes single-quotes in predicate values", () => {
      const plan: QueryPlanBody = {
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              {
                column: "Cluster Name",
                op: "in",
                values: ["O'Brien's region"],
              },
            ],
          },
        ],
      };
      const built = buildQueryPlanDuckdbSql(plan);
      assert.ok(built);
      assert.match(built!.aggregateSql, /'O''Brien''s region'/);
    });
  });

  describe("in-memory executor (applyAggregations)", () => {
    const data = [
      { "Clock-In <09:30": "Yes", "Cluster Name": "North", "Total Visited OL's": 22 },
      { "Clock-In <09:30": "No", "Cluster Name": "North", "Total Visited OL's": 28 },
      { "Clock-In <09:30": "Yes", "Cluster Name": "South", "Total Visited OL's": 27 },
      { "Clock-In <09:30": "Absent", "Cluster Name": "South", "Total Visited OL's": 0 },
      { "Clock-In <09:30": "Yes", "Cluster Name": "North", "Total Visited OL's": 25 },
      { "Clock-In <09:30": "No", "Cluster Name": "North", "Total Visited OL's": 20 },
    ];

    it("countIf gives the right matching count (no groupBy)", () => {
      const result = executeQueryPlan(data, summary, {
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
          {
            column: "*",
            operation: "countIf",
            alias: "total",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes", "No"] },
            ],
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const row = result.data[0]!;
      assert.equal(row.matching, 3, "Yes appears 3 times");
      assert.equal(row.total, 5, "Yes+No appears 5 times (Absent excluded)");
    });

    it("sumIf totals the column only over matching rows", () => {
      const result = executeQueryPlan(data, summary, {
        aggregations: [
          {
            column: "Total Visited OL's",
            operation: "sumIf",
            alias: "yes_visits",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data[0]!.yes_visits, 22 + 27 + 25);
    });

    it("countIf inside groupBy splits per group", () => {
      const result = executeQueryPlan(data, summary, {
        groupBy: ["Cluster Name"],
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes"] },
            ],
          },
          {
            column: "*",
            operation: "countIf",
            alias: "total",
            predicate: [
              { column: "Clock-In <09:30", op: "in", values: ["Yes", "No"] },
            ],
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const byCluster = new Map(
        result.data.map((r) => [r["Cluster Name"], r]),
      );
      assert.equal(byCluster.get("North")?.matching, 2);
      assert.equal(byCluster.get("North")?.total, 4);
      assert.equal(byCluster.get("South")?.matching, 1);
      assert.equal(byCluster.get("South")?.total, 1);
    });
  });
});
