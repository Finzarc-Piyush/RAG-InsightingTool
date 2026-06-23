import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryPlanDuckdbSql,
  canExecuteQueryPlanOnDuckDb,
} from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";

describe("queryPlanDuckdbExecutor", () => {
  it("canExecuteQueryPlanOnDuckDb rejects dateAggregationPeriod plans", () => {
    assert.equal(
      canExecuteQueryPlanOnDuckDb({
        groupBy: ["Order Date"],
        dateAggregationPeriod: "month",
        aggregations: [{ column: "Sales", operation: "sum" }],
      }),
      false
    );
  });

  it("canExecuteQueryPlanOnDuckDb accepts __tf_month groupBy with sum", () => {
    assert.equal(
      canExecuteQueryPlanOnDuckDb({
        groupBy: ["__tf_month__Order_Date"],
        aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
        sort: [{ column: "__tf_month__Order_Date", direction: "asc" }],
      }),
      true
    );
  });

  it("buildQueryPlanDuckdbSql builds GROUP BY and ORDER BY", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["__tf_month__Order_Date"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      sort: [{ column: "__tf_month__Order_Date", direction: "asc" }],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /GROUP BY/);
    assert.match(built!.aggregateSql, /ORDER BY/);
    assert.match(built!.aggregateSql, /SUM\(TRY_CAST\("Sales" AS DOUBLE\)\)/);
    assert.match(built!.countSql, /SELECT COUNT\(\*\)/);
  });

  it("buildQueryPlanDuckdbSql quotes UI-style month facet column id", () => {
    const x = "Month · Order Date";
    const built = buildQueryPlanDuckdbSql({
      groupBy: [x],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      sort: [{ column: x, direction: "asc" }],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /Month · Order Date/);
  });

  // TOD-AGG · a time-of-day (clock) measure must average in seconds, not be
  // TRY_CAST to DOUBLE (which NULLs every row → the all-"—" bug).
  const todSummary = {
    rowCount: 5,
    columnCount: 2,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      {
        name: "Clock-In Time",
        type: "string",
        sampleValues: [],
        timeOfDay: { sentinelValues: ["Absent"] },
      },
    ],
  } as unknown as DataSummary;

  it("averages a time-of-day column via EXTRACT(EPOCH FROM TRY_CAST … AS TIME)", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Clock-In Time", operation: "avg", alias: "avg_clock_in_time" },
        ],
      },
      {
        tableColumns: new Set(["Cluster Name", "Clock-In Time"]),
        summary: todSummary,
      }
    );
    assert.ok(built);
    assert.match(
      built!.aggregateSql,
      /AVG\(EXTRACT\(EPOCH FROM TRY_CAST\("Clock-In Time" AS TIME\)\)\)/
    );
    assert.doesNotMatch(
      built!.aggregateSql,
      /AVG\(TRY_CAST\("Clock-In Time" AS DOUBLE\)\)/
    );
    assert.deepEqual(built!.clockAggAliases, ["avg_clock_in_time"]);
  });

  it("leaves a normal numeric average as a DOUBLE cast (no clock aliases)", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Cluster Name"],
        aggregations: [{ column: "Total PC", operation: "avg", alias: "avg_pc" }],
      },
      {
        tableColumns: new Set(["Cluster Name", "Total PC"]),
        summary: {
          rowCount: 2,
          columnCount: 2,
          columns: [
            { name: "Cluster Name", type: "string", sampleValues: [] },
            { name: "Total PC", type: "number", sampleValues: [] },
          ],
        } as unknown as DataSummary,
      }
    );
    assert.ok(built);
    assert.match(built!.aggregateSql, /AVG\(TRY_CAST\("Total PC" AS DOUBLE\)\)/);
    assert.equal(built!.clockAggAliases, undefined);
  });
});
