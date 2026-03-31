import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeQueryPlan } from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

describe("executeQueryPlan sort on aggregation outputs", () => {
  const data = [
    { Category: "Technology", Sales: 100 },
    { Category: "Technology", Sales: 50 },
    { Category: "Furniture", Sales: 200 },
  ];

  const summary: DataSummary = {
    rowCount: 3,
    columnCount: 2,
    columns: [
      { name: "Category", type: "string", sampleValues: ["Technology"] },
      { name: "Sales", type: "number", sampleValues: [100] },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  };

  it("accepts sort by aggregation alias", () => {
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Total_Sales" }],
      sort: [{ column: "Total_Sales", direction: "desc" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.data[0]?.Category, "Furniture");
  });

  it("accepts sort by derived aggregation output name", () => {
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Category"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      sort: [{ column: "Sales_sum", direction: "desc" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.data[0]?.Category, "Furniture");
  });
});

