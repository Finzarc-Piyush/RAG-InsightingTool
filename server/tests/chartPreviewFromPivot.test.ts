import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pivotModelToPreAggregatedChartRows } from "../lib/chartPreviewFromPivot.js";
import type { PivotModel } from "../shared/schema.js";

describe("pivotModelToPreAggregatedChartRows", () => {
  it("uses pathKey segment aligned to rowFields for multi-row layout", () => {
    const model: PivotModel = {
      rowFields: ["Region", "Month · Order Date"],
      colField: null,
      columnFields: [],
      colKeys: [],
      valueSpecs: [{ id: "meas_Sales", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [
          {
            type: "leaf",
            depth: 2,
            label: "Jan",
            pathKey: `West\x1fJan`,
            values: { flatValues: { meas_Sales: 42 }, matrixValues: null },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };

    const rows = pivotModelToPreAggregatedChartRows(
      model,
      "Month · Order Date",
      "Sales"
    );
    assert.equal(rows?.length, 1);
    assert.equal(rows![0]["Month · Order Date"], "Jan");
    assert.equal(rows![0]["Sales"], 42);
  });

  it("returns null when column pivot (matrix) is present", () => {
    const model: PivotModel = {
      rowFields: ["A"],
      colField: "B",
      columnFields: ["B"],
      colKeys: ["x"],
      valueSpecs: [{ id: "meas_Sales", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    assert.equal(
      pivotModelToPreAggregatedChartRows(model, "A", "Sales"),
      null
    );
  });
});
