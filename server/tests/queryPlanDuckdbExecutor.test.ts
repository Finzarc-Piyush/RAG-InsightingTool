import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryPlanDuckdbSql,
  canExecuteQueryPlanOnDuckDb,
} from "../lib/queryPlanDuckdbExecutor.js";

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
});
