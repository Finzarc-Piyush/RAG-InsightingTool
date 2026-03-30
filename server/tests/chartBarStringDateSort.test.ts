import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

describe("processChartData bar + declared date column (string values)", () => {
  it("sorts chronologically instead of by Y magnitude", () => {
    const spec: ChartSpec = {
      type: "bar",
      title: "Sales by date",
      x: "Order Date",
      y: "Sales_sum",
      aggregate: "none",
    };
    const rows = [
      { "Order Date": "1/15/2024", Sales_sum: 100 },
      { "Order Date": "1/1/2024", Sales_sum: 50 },
      { "Order Date": "2/1/2024", Sales_sum: 200 },
    ];
    const declared = ["Order Date"];
    const out = processChartData(rows, spec, declared);
    assert.equal(out.length, 3);
    assert.equal(out[0].Sales_sum, 50);
    assert.equal(out[1].Sales_sum, 100);
    assert.equal(out[2].Sales_sum, 200);
  });
});
