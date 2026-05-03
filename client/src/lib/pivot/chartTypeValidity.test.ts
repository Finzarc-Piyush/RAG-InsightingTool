import test from "node:test";
import assert from "node:assert/strict";
import { chartTypeValidityForPivot } from "./chartTypeValidity.ts";
import type { PivotUiConfig } from "./types.ts";

function configWith(
  rows: string[],
  values: string[],
  columns: string[] = []
): PivotUiConfig {
  return {
    filters: [],
    columns,
    rows,
    values: values.map((field) => ({
      id: `meas_${field}`,
      field,
      agg: "sum" as const,
    })),
    unused: [],
  };
}

test("PV2 · bar/line/area always valid for one row + one numeric measure", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v.bar.valid, true);
  assert.equal(v.line.valid, true);
  assert.equal(v.area.valid, true);
});

test("PV2 · pie/donut disabled past 8 categories with reason", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 12,
  });
  assert.equal(v.pie.valid, false);
  assert.equal(v.donut.valid, false);
  assert.match(v.pie.reason, /past 8/);
});

test("PV2 · scatter requires ≥2 numeric measures", () => {
  const v1 = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v1.scatter.valid, false);
  assert.match(v1.scatter.reason, /two numeric measures/);

  const v2 = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales", "Cost"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v2.scatter.valid, true);
});

test("PV2 · bubble requires ≥3 numeric measures", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales", "Cost"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v.bubble.valid, false);

  const v2 = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales", "Cost", "Margin"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v2.bubble.valid, true);
});

test("PV2 · heatmap needs a column dimension", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 4,
  });
  assert.equal(v.heatmap.valid, false);
  assert.match(v.heatmap.reason, /column dimension/);

  const v2 = chartTypeValidityForPivot({
    pivotConfig: configWith(["Region"], ["Sales"], ["Channel"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 4,
    colKeyCount: 3,
  });
  assert.equal(v2.heatmap.valid, true);
});

test("PV2 · radar needs ≥3 numeric measures with row dim, ≤8 spokes", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Brand"], ["Volume", "Value", "Share"]),
    numericColumns: ["Volume", "Value", "Share"],
    dateColumns: [],
    rowCount: 6,
  });
  assert.equal(v.radar.valid, true);

  const tooMany = chartTypeValidityForPivot({
    pivotConfig: configWith(["Brand"], ["Volume", "Value", "Share"]),
    numericColumns: ["Volume", "Value", "Share"],
    dateColumns: [],
    rowCount: 30,
  });
  assert.equal(tooMany.radar.valid, false);
  assert.match(tooMany.radar.reason, /past 8 spokes/);
});

test("PV2 · waterfall valid as soon as bar is", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith(["Driver"], ["Contribution"]),
    numericColumns: ["Contribution"],
    dateColumns: [],
    rowCount: 5,
  });
  assert.equal(v.waterfall.valid, true);
});

test("PV2 · invalid when no row + numeric value", () => {
  const v = chartTypeValidityForPivot({
    pivotConfig: configWith([], []),
    numericColumns: [],
    dateColumns: [],
    rowCount: 0,
  });
  assert.equal(v.bar.valid, false);
  assert.equal(v.line.valid, false);
  assert.equal(v.pie.valid, false);
  assert.equal(v.heatmap.valid, false);
  assert.equal(v.radar.valid, false);
});
