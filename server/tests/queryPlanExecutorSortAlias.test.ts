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

  // Executor-layer twin of Fix C (d7e5aece): a boolean-indicator rate plan sorts
  // by its computedAggregations alias. Before the fix this failed at runtime with
  // "Column not in schema: <alias>" because assertPlanColumnsAllowed built
  // allowedSort from aggregation aliases only, never computedAggregations.
  it("accepts sort by a computedAggregations alias (rate)", () => {
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Category"],
      aggregations: [
        { column: "Sales", operation: "sum", alias: "matching" },
        { column: "Sales", operation: "max", alias: "total" },
      ],
      computedAggregations: [{ alias: "rate", expression: "matching / total" }],
      sort: [{ column: "rate", direction: "desc" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // Technology: 150 / 100 = 1.5 ; Furniture: 200 / 200 = 1.0 → Technology first.
    assert.equal(out.data[0]?.Category, "Technology");
  });
});

