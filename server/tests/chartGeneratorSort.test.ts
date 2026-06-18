import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

const ageData = [
  { Age: "25", Survived: 30 },
  { Age: "5", Survived: 50 },
  { Age: "10", Survived: 10 },
  { Age: "40", Survived: 5 },
];

const col = (rows: Array<Record<string, any>>, key: string) => rows.map((r) => r[key]);

describe("processChartData · bar sort (Wave S3)", () => {
  it("auto axis-orders a numeric x (survived by age) ascending by DEFAULT", () => {
    const spec: ChartSpec = { type: "bar", title: "t", x: "Age", y: "Survived", aggregate: "sum" };
    const out = processChartData(ageData, spec, [], undefined);
    assert.deepEqual(col(out, "Age"), ["5", "10", "25", "40"]);
    // the resolved default is baked back onto the spec for persistence
    assert.deepEqual(spec.sort, { by: "category", direction: "asc" });
  });

  it("explicit value-desc sort overrides the auto default", () => {
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Age", y: "Survived", aggregate: "sum",
      sort: { by: "value", direction: "desc" },
    };
    const out = processChartData(ageData, spec, [], undefined);
    assert.deepEqual(col(out, "Survived"), [50, 30, 10, 5]);
  });

  it("explicit category-desc reverses the axis", () => {
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Age", y: "Survived", aggregate: "sum",
      sort: { by: "category", direction: "desc" },
    };
    const out = processChartData(ageData, spec, [], undefined);
    assert.deepEqual(col(out, "Age"), ["40", "25", "10", "5"]);
  });

  it("nominal x keeps the historic value-desc default", () => {
    const brands = [
      { Brand: "Parachute", Sales: 10 },
      { Brand: "Nihar", Sales: 30 },
      { Brand: "Saffola", Sales: 20 },
    ];
    const spec: ChartSpec = { type: "bar", title: "t", x: "Brand", y: "Sales", aggregate: "sum" };
    const out = processChartData(brands, spec, [], undefined);
    assert.deepEqual(col(out, "Sales"), [30, 20, 10]);
    assert.deepEqual(spec.sort, { by: "value", direction: "desc" });
  });

  it("legacy sortDirection:asc still works (value ascending)", () => {
    const brands = [
      { Brand: "Parachute", Sales: 10 },
      { Brand: "Nihar", Sales: 30 },
      { Brand: "Saffola", Sales: 20 },
    ];
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Brand", y: "Sales", aggregate: "sum",
      sortDirection: "asc",
    };
    const out = processChartData(brands, spec, [], undefined);
    assert.deepEqual(col(out, "Sales"), [10, 20, 30]);
  });

  it("maxRows selects top-N by value, then orders by axis ascending", () => {
    const many = [
      { Age: "1", Survived: 5 },
      { Age: "2", Survived: 100 },
      { Age: "3", Survived: 1 },
      { Age: "4", Survived: 80 },
      { Age: "5", Survived: 90 },
    ];
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Age", y: "Survived", aggregate: "sum",
      sort: { by: "category", direction: "asc" }, maxRows: 3,
    };
    const out = processChartData(many, spec, [], undefined);
    assert.deepEqual(col(out, "Age"), ["2", "4", "5"]);
  });
});

describe("processChartData · multi-series bar sort (Wave S3)", () => {
  const data = [
    { Age: "25", Gender: "M", N: 3 },
    { Age: "25", Gender: "F", N: 1 },
    { Age: "5", Gender: "M", N: 2 },
    { Age: "5", Gender: "F", N: 2 },
    { Age: "10", Gender: "M", N: 10 },
    { Age: "10", Gender: "F", N: 10 },
  ];

  it("honours category-asc on grouped/stacked bars (was hardcoded desc-by-first-series)", () => {
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Age", y: "N", seriesColumn: "Gender",
      aggregate: "sum", sort: { by: "category", direction: "asc" },
    };
    const out = processChartData(data, spec, [], undefined);
    assert.deepEqual(col(out, "Age"), ["5", "10", "25"]);
  });

  it("value sort uses the ROW TOTAL across series and preserves seriesKeys", () => {
    const spec: ChartSpec = {
      type: "bar", title: "t", x: "Age", y: "N", seriesColumn: "Gender",
      aggregate: "sum", sort: { by: "value", direction: "desc" },
    };
    const out = processChartData(data, spec, [], undefined);
    // totals: 5→4, 10→20, 25→4 ⇒ desc by total = 10, then {5,25} tie broken by axis
    assert.equal(out[0]?.Age, "10");
    assert.ok(spec.seriesKeys && spec.seriesKeys.length === 2);
  });
});
