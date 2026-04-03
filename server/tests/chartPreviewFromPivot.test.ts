import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pivotModelToPreAggregatedChartRows,
  pivotModelRowsForChartSpec,
  resolvePivotValueSpecForChartY,
} from "../lib/chartPreviewFromPivot.js";
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

  it("rolls up duplicate X across outer row dimensions when no seriesColumn", () => {
    const model: PivotModel = {
      rowFields: ["Region", "Month"],
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
            values: { flatValues: { meas_Sales: 10 }, matrixValues: null },
          },
          {
            type: "leaf",
            depth: 2,
            label: "Jan",
            pathKey: `East\x1fJan`,
            values: { flatValues: { meas_Sales: 25 }, matrixValues: null },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    const rows = pivotModelToPreAggregatedChartRows(model, "Month", "Sales");
    assert.equal(rows?.length, 1);
    assert.equal(rows![0].Month, "Jan");
    assert.equal(rows![0].Sales, 35);
  });
});

describe("resolvePivotValueSpecForChartY", () => {
  it("maps analytical alias Sales_sum to pivot value spec Sales when Sales is numeric", () => {
    const valueSpecs = [{ id: "meas_Sales", field: "Sales", agg: "sum" as const }];
    const r = resolvePivotValueSpecForChartY("Sales_sum", valueSpecs, ["Sales"]);
    assert.ok(r);
    assert.equal(r!.canonicalY, "Sales");
    assert.equal(r!.valueSpec.field, "Sales");
  });
});

describe("pivotModelRowsForChartSpec", () => {
  it("accepts y Sales_sum when numericColumns includes base Sales", () => {
    const model: PivotModel = {
      rowFields: ["Category"],
      colField: null,
      columnFields: [],
      colKeys: [],
      valueSpecs: [{ id: "meas_Sales", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [
          {
            type: "leaf",
            depth: 1,
            label: "A",
            pathKey: "A",
            values: { flatValues: { meas_Sales: 42 }, matrixValues: null },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    const rows = pivotModelRowsForChartSpec(
      model,
      {
        type: "bar",
        title: "t",
        x: "Category",
        y: "Sales_sum",
      },
      ["Sales"]
    );
    assert.equal(rows?.length, 1);
    assert.equal(rows![0].Category, "A");
    assert.equal(rows![0].Sales, 42);
    assert.equal(Object.prototype.hasOwnProperty.call(rows![0], "Sales_sum"), false);
  });

  it("expands column pivot to long rows when seriesColumn matches col field", () => {
    const model: PivotModel = {
      rowFields: ["Region"],
      colField: "Quarter",
      columnFields: ["Quarter"],
      colKeys: ["Q1", "Q2"],
      valueSpecs: [{ id: "meas_Sales", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [
          {
            type: "leaf",
            depth: 1,
            label: "North",
            pathKey: "North",
            values: {
              flatValues: null,
              matrixValues: {
                Q1: { meas_Sales: 4 },
                Q2: { meas_Sales: 9 },
              },
            },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    const rows = pivotModelRowsForChartSpec(model, {
      type: "bar",
      title: "t",
      x: "Region",
      y: "Sales",
      seriesColumn: "Quarter",
    });
    assert.equal(rows?.length, 2);
    const q1 = rows!.find((r) => r.Quarter === "Q1");
    const q2 = rows!.find((r) => r.Quarter === "Q2");
    assert.ok(q1 && q1.Sales === 4 && q1.Region === "North");
    assert.ok(q2 && q2.Sales === 9 && q2.Region === "North");
  });

  it("emits long rows for two row dimensions when seriesColumn matches second row field", () => {
    const model: PivotModel = {
      rowFields: ["Month", "Region"],
      colField: null,
      columnFields: [],
      colKeys: [],
      valueSpecs: [{ id: "m", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [
          {
            type: "leaf",
            depth: 2,
            label: "West",
            pathKey: `Jan\x1fWest`,
            values: { flatValues: { m: 3 }, matrixValues: null },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    const rows = pivotModelRowsForChartSpec(model, {
      type: "line",
      title: "t",
      x: "Month",
      y: "Sales",
      seriesColumn: "Region",
    });
    assert.equal(rows?.length, 1);
    assert.equal(rows![0].Month, "Jan");
    assert.equal(rows![0].Region, "West");
    assert.equal(rows![0].Sales, 3);
  });

  it("emits one long row per leaf for three row fields when x and series are first two levels", () => {
    const model: PivotModel = {
      rowFields: ["Region", "Category", "Segment"],
      colField: null,
      columnFields: [],
      colKeys: [],
      valueSpecs: [{ id: "m", field: "Sales", agg: "sum" }],
      tree: {
        nodes: [
          {
            type: "leaf",
            depth: 3,
            label: "A",
            pathKey: `West\x1fTechnology\x1fSegA`,
            values: { flatValues: { m: 10 }, matrixValues: null },
          },
          {
            type: "leaf",
            depth: 3,
            label: "B",
            pathKey: `West\x1fTechnology\x1fSegB`,
            values: { flatValues: { m: 20 }, matrixValues: null },
          },
        ],
        grandTotal: { flatValues: null, matrixValues: null },
      },
      columnFieldTruncated: false,
    };
    const rows = pivotModelRowsForChartSpec(model, {
      type: "bar",
      title: "t",
      x: "Region",
      y: "Sales",
      seriesColumn: "Category",
    });
    assert.equal(rows?.length, 2);
    const sum = rows!.reduce((acc, r) => acc + (r.Sales as number), 0);
    assert.equal(sum, 30);
    for (const r of rows!) {
      assert.equal(r.Region, "West");
      assert.equal(r.Category, "Technology");
    }
  });
});
