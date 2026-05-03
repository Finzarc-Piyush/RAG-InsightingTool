import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chartSpecV2Schema,
  chartV2MarkSchema,
  chartEncodingSchema,
  chartTransformSchema,
  chartLayerSchema,
  chartSourceSchema,
  isChartSpecV2,
} from "../shared/schema.js";

describe("ChartSpecV2 · marks", () => {
  it("accepts the 16 visx marks plus 9 echarts specialty marks", () => {
    const marks = [
      "point",
      "line",
      "area",
      "bar",
      "arc",
      "rect",
      "rule",
      "text",
      "box",
      "errorbar",
      "regression",
      "combo",
      "waterfall",
      "funnel",
      "bubble",
      "radar",
      "treemap",
      "sunburst",
      "sankey",
      "parallel",
      "calendar",
      "choropleth",
      "candlestick",
      "gauge",
      "kpi",
    ];
    for (const m of marks) {
      assert.ok(
        chartV2MarkSchema.safeParse(m).success,
        `mark "${m}" rejected`
      );
    }
    assert.equal(marks.length, 25);
  });

  it("rejects unknown marks", () => {
    assert.equal(chartV2MarkSchema.safeParse("nope").success, false);
    assert.equal(chartV2MarkSchema.safeParse("").success, false);
  });
});

describe("ChartSpecV2 · encoding", () => {
  it("parses a minimal x/y encoding", () => {
    const r = chartEncodingSchema.safeParse({
      x: { field: "Region", type: "n" },
      y: { field: "Revenue", type: "q", aggregate: "sum" },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("parses a multi-channel encoding with color/size/facet", () => {
    const r = chartEncodingSchema.safeParse({
      x: { field: "Region", type: "n" },
      y: { field: "Revenue", type: "q", aggregate: "sum" },
      color: { field: "Year", type: "o", scheme: "qualitative" },
      size: { field: "Volume", type: "q", range: [4, 32] },
      facetCol: { field: "Channel", type: "n", columns: 3 },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("accepts both encoding-channel and value-only opacity", () => {
    assert.ok(
      chartEncodingSchema.safeParse({
        opacity: { value: 0.5 },
      }).success
    );
    assert.ok(
      chartEncodingSchema.safeParse({
        opacity: { field: "Volume", type: "q" },
      }).success
    );
  });

  it("rejects opacity value outside [0,1]", () => {
    assert.equal(
      chartEncodingSchema.safeParse({ opacity: { value: 1.5 } }).success,
      false
    );
  });
});

describe("ChartSpecV2 · transforms", () => {
  it("parses filter / calculate / aggregate / fold / bin / window / regression", () => {
    const all = [
      { type: "filter", expr: "Revenue > 0" },
      { type: "calculate", as: "Margin", expr: "Revenue - Cost" },
      {
        type: "aggregate",
        groupby: ["Region"],
        ops: [{ op: "sum", field: "Revenue", as: "rev_total" }],
      },
      { type: "fold", fields: ["a", "b", "c"], as: ["k", "v"] },
      { type: "bin", field: "Age", as: "AgeBin", maxbins: 10 },
      {
        type: "window",
        ops: [{ op: "moving_avg", field: "Revenue", as: "MA", window: 7 }],
      },
      { type: "regression", on: "Revenue", method: "linear" },
    ];
    for (const t of all) {
      const r = chartTransformSchema.safeParse(t);
      assert.ok(r.success, `${t.type}: ${r.success ? "" : String(r.error)}`);
    }
  });

  it("rejects unknown transform type", () => {
    assert.equal(
      chartTransformSchema.safeParse({ type: "moonwalk" }).success,
      false
    );
  });
});

describe("ChartSpecV2 · layers", () => {
  it("parses each of the 6 layer types", () => {
    const all = [
      { type: "reference-line", on: "y", value: "median", label: "Median" },
      { type: "reference-line", on: "x", value: 100 },
      { type: "trend", on: "y", method: "linear", ci: 0.95 },
      { type: "forecast", on: "y", horizon: 4, method: "exp-smoothing" },
      { type: "annotation", x: "2024-01", text: "Launch" },
      { type: "outliers", threshold: 2, style: "callout" },
      { type: "comparison", against: "prior-period", style: "faded" },
    ];
    for (const l of all) {
      const r = chartLayerSchema.safeParse(l);
      assert.ok(
        r.success,
        `${(l as { type: string }).type}: ${r.success ? "" : String(r.error)}`
      );
    }
  });

  it("rejects forecast horizon out of range", () => {
    assert.equal(
      chartLayerSchema.safeParse({
        type: "forecast",
        on: "y",
        horizon: 999,
        method: "linear",
      }).success,
      false
    );
  });
});

describe("ChartSpecV2 · source", () => {
  it("accepts inline / session-ref / pivot-query / analytical-query", () => {
    assert.ok(
      chartSourceSchema.safeParse({
        kind: "inline",
        rows: [{ a: 1, b: "x" }],
      }).success
    );
    assert.ok(
      chartSourceSchema.safeParse({
        kind: "session-ref",
        sessionId: "abc-123",
        dataVersion: 7,
      }).success
    );
    assert.ok(
      chartSourceSchema.safeParse({
        kind: "pivot-query",
        queryRef: "q-42",
      }).success
    );
    assert.ok(
      chartSourceSchema.safeParse({
        kind: "analytical-query",
        queryRef: "aq-42",
      }).success
    );
  });
});

describe("ChartSpecV2 · root spec", () => {
  it("parses a complete bar spec with encodings + config", () => {
    const r = chartSpecV2Schema.safeParse({
      version: 2,
      mark: "bar",
      encoding: {
        x: { field: "Region", type: "n" },
        y: { field: "Revenue", type: "q", aggregate: "sum" },
        color: { field: "Year", type: "o" },
      },
      source: {
        kind: "session-ref",
        sessionId: "s-1",
        dataVersion: 1,
      },
      config: {
        title: { text: "Revenue by region" },
        legend: { position: "right", interactive: true },
        interactions: { brush: false, click: "cross-filter", hoverDim: true },
      },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("parses a sankey with transforms + layers", () => {
    const r = chartSpecV2Schema.safeParse({
      version: 2,
      mark: "sankey",
      encoding: {
        x: { field: "from", type: "n" },
        y: { field: "to", type: "n" },
        size: { field: "weight", type: "q" },
      },
      transform: [{ type: "filter", expr: "weight > 0" }],
      source: { kind: "inline", rows: [{ from: "A", to: "B", weight: 5 }] },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("rejects spec without version=2", () => {
    const r = chartSpecV2Schema.safeParse({
      mark: "bar",
      encoding: {},
      source: { kind: "inline", rows: [] },
    });
    assert.equal(r.success, false);
  });
});

describe("ChartSpecV2 · isChartSpecV2 discriminator", () => {
  it("returns true for v2 shape", () => {
    assert.equal(
      isChartSpecV2({
        version: 2,
        mark: "bar",
        encoding: {},
        source: { kind: "inline", rows: [] },
      }),
      true
    );
  });

  it("returns false for v1 shape (no version field)", () => {
    assert.equal(
      isChartSpecV2({
        type: "bar",
        title: "X",
        x: "a",
        y: "b",
      }),
      false
    );
  });

  it("returns false for null / non-objects / wrong version", () => {
    assert.equal(isChartSpecV2(null), false);
    assert.equal(isChartSpecV2(undefined), false);
    assert.equal(isChartSpecV2("bar"), false);
    assert.equal(isChartSpecV2({ version: 1 }), false);
    assert.equal(isChartSpecV2({ version: 2 }), false); // missing mark
  });
});
