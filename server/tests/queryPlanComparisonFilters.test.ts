import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queryPlanBodySchema,
  executeQueryPlan,
  type QueryPlanBody,
} from "../lib/queryPlanExecutor.js";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  columns: [
    { name: "Clock-In Time", type: "text", uniqueValues: 100 },
    { name: "Sales", type: "numeric", uniqueValues: 50 },
    { name: "Region", type: "text", uniqueValues: 5 },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
  totalRows: 0,
  sampleRows: [],
};

describe("Wave CMP1 · comparison + range operators on dimensionFilter", () => {
  describe("schema", () => {
    it("accepts each scalar comparison op with a single value", () => {
      for (const op of ["eq", "neq", "lt", "lte", "gt", "gte"]) {
        const parsed = queryPlanBodySchema.safeParse({
          dimensionFilters: [{ column: "Sales", op, values: ["100"] }],
          limit: 50,
        });
        assert.equal(parsed.success, true, `should accept op=${op}`);
      }
    });

    it("rejects scalar comparison ops with wrong values length", () => {
      for (const op of ["eq", "lt", "gte"]) {
        const tooMany = queryPlanBodySchema.safeParse({
          dimensionFilters: [{ column: "Sales", op, values: ["1", "2"] }],
          limit: 50,
        });
        assert.equal(tooMany.success, false, `${op} must reject 2 values`);
        const empty = queryPlanBodySchema.safeParse({
          dimensionFilters: [{ column: "Sales", op, values: [] }],
          limit: 50,
        });
        assert.equal(empty.success, false, `${op} must reject empty`);
      }
    });

    it("between requires exactly 2 values", () => {
      const ok = queryPlanBodySchema.safeParse({
        dimensionFilters: [
          { column: "Sales", op: "between", values: ["10", "20"] },
        ],
        limit: 50,
      });
      assert.equal(ok.success, true);
      const tooFew = queryPlanBodySchema.safeParse({
        dimensionFilters: [{ column: "Sales", op: "between", values: ["10"] }],
        limit: 50,
      });
      assert.equal(tooFew.success, false);
      const tooMany = queryPlanBodySchema.safeParse({
        dimensionFilters: [
          { column: "Sales", op: "between", values: ["1", "2", "3"] },
        ],
        limit: 50,
      });
      assert.equal(tooMany.success, false);
    });
  });

  describe("DuckDB SQL builder", () => {
    it("emits TRY_CAST DOUBLE comparison for numeric-looking values", () => {
      const built = buildQueryPlanDuckdbSql({
        groupBy: ["Region"],
        aggregations: [{ column: "Sales", operation: "sum" }],
        dimensionFilters: [{ column: "Sales", op: "gt", values: ["100000"] }],
      });
      assert.ok(built);
      assert.match(built!.aggregateSql, /TRY_CAST\("Sales" AS DOUBLE\) > 100000/);
    });

    it("emits VARCHAR comparison for non-numeric (HH:MM:SS) values", () => {
      const built = buildQueryPlanDuckdbSql({
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In Time", op: "lt", values: ["09:30:00"] },
            ],
          },
        ],
      });
      assert.ok(built);
      assert.match(
        built!.aggregateSql,
        /CAST\("Clock-In Time" AS VARCHAR\) < '09:30:00'/,
      );
    });

    it("emits BETWEEN syntax for between op", () => {
      const built = buildQueryPlanDuckdbSql({
        aggregations: [{ column: "Sales", operation: "sum" }],
        dimensionFilters: [
          { column: "Sales", op: "between", values: ["1000", "5000"] },
        ],
      });
      assert.ok(built);
      assert.match(
        built!.aggregateSql,
        /TRY_CAST\("Sales" AS DOUBLE\) BETWEEN 1000 AND 5000/,
      );
    });

    it("escapes single-quotes in string comparison values", () => {
      const built = buildQueryPlanDuckdbSql({
        aggregations: [{ column: "Sales", operation: "sum" }],
        dimensionFilters: [
          { column: "Region", op: "eq", values: ["O'Brien"] },
        ],
      });
      assert.ok(built);
      assert.match(built!.aggregateSql, /'O''Brien'/);
    });
  });

  describe("in-memory executor", () => {
    const data = [
      { "Clock-In Time": "09:15:00", Region: "North", Sales: 100 },
      { "Clock-In Time": "09:45:34", Region: "South", Sales: 200 },
      { "Clock-In Time": "10:05:45", Region: "North", Sales: 50 },
      { "Clock-In Time": "Absent", Region: "South", Sales: 0 },
      { "Clock-In Time": "09:25:00", Region: "North", Sales: 300 },
    ];

    it("lt filter on HH:MM:SS strings keeps only pre-cutoff times", () => {
      const result = executeQueryPlan(data, summary, {
        dimensionFilters: [
          { column: "Clock-In Time", op: "lt", values: ["09:30:00"] },
          { column: "Clock-In Time", op: "neq", values: ["Absent"] },
        ],
        limit: 100,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.length, 2);
      const times = result.data.map((r) => r["Clock-In Time"]).sort();
      assert.deepEqual(times, ["09:15:00", "09:25:00"]);
    });

    it("between filter on numeric column", () => {
      const result = executeQueryPlan(data, summary, {
        dimensionFilters: [
          { column: "Sales", op: "between", values: ["100", "250"] },
        ],
        limit: 100,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.length, 2);
    });

    it("gt + lt range emulation works on numeric", () => {
      const result = executeQueryPlan(data, summary, {
        dimensionFilters: [
          { column: "Sales", op: "gt", values: ["100"] },
          { column: "Sales", op: "lt", values: ["300"] },
        ],
        limit: 100,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.length, 1);
      assert.equal(result.data[0]!.Sales, 200);
    });
  });

  describe("PCT1 + CMP1 integration — '% of clock-ins before 9:30'", () => {
    const data = [
      { "Clock-In Time": "09:15:00" },
      { "Clock-In Time": "09:45:34" },
      { "Clock-In Time": "10:05:45" },
      { "Clock-In Time": "Absent" },
      { "Clock-In Time": "09:25:00" },
      { "Clock-In Time": "09:50:00" },
    ];

    it("countIf with a comparison predicate against a TIME column", () => {
      const result = executeQueryPlan(data, summary, {
        aggregations: [
          {
            column: "*",
            operation: "countIf",
            alias: "matching",
            predicate: [
              { column: "Clock-In Time", op: "lt", values: ["09:30:00"] },
              { column: "Clock-In Time", op: "neq", values: ["Absent"] },
            ],
          },
          {
            column: "*",
            operation: "countIf",
            alias: "total",
            predicate: [
              { column: "Clock-In Time", op: "neq", values: ["Absent"] },
            ],
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const row = result.data[0]!;
      assert.equal(row.matching, 2, "two clock-ins before 09:30:00");
      assert.equal(row.total, 5, "five non-Absent rows");
    });
  });
});
