import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processChartData, pivotLongToWideBar } from "../lib/chartGenerator.js";
import { resampleTimeSeriesMulti } from "../lib/chartDownsampling.js";
import type { ChartSpec } from "../shared/schema.js";

describe("processChartData multi-series line", () => {
  it("pivots long-format rows into seriesKeys for line + seriesColumn", () => {
    const data = [
      { Month: "Jan", Region: "A", Sales: 10 },
      { Month: "Jan", Region: "B", Sales: 20 },
      { Month: "Feb", Region: "A", Sales: 5 },
      { Month: "Feb", Region: "B", Sales: 15 },
    ];
    const spec: ChartSpec = {
      type: "line",
      title: "t",
      x: "Month",
      y: "Sales",
      seriesColumn: "Region",
      aggregate: "sum",
    };
    const out = processChartData(data, spec, [], undefined);
    assert.ok(out.length >= 2);
    assert.ok(spec.seriesKeys && spec.seriesKeys.length >= 2);
    const rowJan = out.find((r) => r.Month === "Jan");
    assert.ok(rowJan);
    for (const k of spec.seriesKeys!) {
      assert.ok(typeof rowJan![k] === "number");
    }
  });

  it("aggregates multiple numeric columns when aggregate is sum", () => {
    const data = [
      { Day: "Mon", A: 1, B: 2 },
      { Day: "Mon", A: 3, B: 4 },
      { Day: "Tue", A: 10, B: 0 },
    ];
    const spec: ChartSpec = {
      type: "line",
      title: "t",
      x: "Day",
      y: "A",
      y2: "B",
      aggregate: "sum",
    };
    const out = processChartData(data, { ...spec }, [], undefined);
    assert.equal(out.length, 2);
    const mon = out.find((r) => r.Day === "Mon");
    assert.ok(mon);
    assert.equal(mon!.A, 4);
    assert.equal(mon!.B, 6);
  });
});

describe("resampleTimeSeriesMulti", () => {
  it("preserves multiple value columns per bucket", () => {
    const data = [
      { d: "2024-01-01", s1: 1, s2: 10 },
      { d: "2024-01-02", s1: 2, s2: 20 },
    ];
    const out = resampleTimeSeriesMulti(data, "d", ["s1", "s2"], "month", "sum");
    assert.equal(out.length, 1);
    assert.equal(typeof out[0]!.s1, "number");
    assert.equal(typeof out[0]!.s2, "number");
    assert.equal(out[0]!.s1, 3);
    assert.equal(out[0]!.s2, 30);
  });
});

describe("pivotLongToWideBar", () => {
  it("sets seriesKeys for downstream downsampling", () => {
    const data = [
      { x: "a", cat: "u", v: 1 },
      { x: "a", cat: "v", v: 2 },
    ];
    const spec: ChartSpec = {
      type: "bar",
      title: "t",
      x: "x",
      y: "v",
      seriesColumn: "cat",
      aggregate: "sum",
    };
    const { rows, seriesKeys } = pivotLongToWideBar(
      data,
      "x",
      "cat",
      "v",
      "sum",
      spec
    );
    assert.equal(rows.length, 1);
    assert.ok(seriesKeys.length >= 1);
  });

  it("orders seriesKeys by descending total even below the series cap (W-ORD1)", () => {
    // Three series in scrambled encounter order; totals: big=100, mid=30, small=5.
    const data = [
      { x: "g1", cat: "small", v: 2 },
      { x: "g1", cat: "big", v: 60 },
      { x: "g1", cat: "mid", v: 20 },
      { x: "g2", cat: "small", v: 3 },
      { x: "g2", cat: "big", v: 40 },
      { x: "g2", cat: "mid", v: 10 },
    ];
    const spec: ChartSpec = {
      type: "bar",
      title: "t",
      x: "x",
      y: "v",
      seriesColumn: "cat",
      aggregate: "sum",
    };
    const { seriesKeys } = pivotLongToWideBar(data, "x", "cat", "v", "sum", spec);
    // Largest total first → declared as the first <Bar> → bottom of the stack.
    assert.deepEqual(seriesKeys, ["big", "mid", "small"]);
  });
});
