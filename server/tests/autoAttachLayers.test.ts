import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachAutoLayers,
  inferAutoLayers,
} from "../lib/charts/autoAttachLayers.js";
import type { ChartSpec } from "../shared/schema.js";

function lineChart(): ChartSpec {
  return {
    type: "line",
    title: "Trend",
    x: "Month",
    y: "Revenue",
  };
}

function barChart(): ChartSpec {
  return {
    type: "bar",
    title: "Bars",
    x: "Region",
    y: "Revenue",
  };
}

function heatmapChart(): ChartSpec {
  return {
    type: "heatmap",
    title: "Heat",
    x: "Row",
    y: "Col",
    z: "Value",
  };
}

describe("autoAttachLayers · target reference line", () => {
  it("detects 'target of 100K' and adds a reference-line", () => {
    const out = inferAutoLayers(barChart(), "Are we hitting our target of 100K?");
    const ref = out.find((l) => l.type === "reference-line");
    assert.ok(ref);
    assert.equal(ref!.value, 100_000);
    assert.match(ref!.label!, /Target/);
  });

  it("parses K/M/B suffixes", () => {
    assert.equal(
      inferAutoLayers(barChart(), "target of 5M for revenue").find(
        (l) => l.type === "reference-line",
      )?.value,
      5_000_000,
    );
    assert.equal(
      inferAutoLayers(barChart(), "Goal: 2.5B").find(
        (l) => l.type === "reference-line",
      )?.value,
      2_500_000_000,
    );
  });

  it("doesn't attach when no target keyword", () => {
    assert.equal(
      inferAutoLayers(barChart(), "Show revenue by region").length,
      0,
    );
  });

  // Fix-2 · false-positive guard
  it("does NOT attach when number has no currency or magnitude suffix", () => {
    // "100 customers" → no currency, no K/M/B suffix → skip.
    const out = inferAutoLayers(
      barChart(),
      "What's the target audience of 100 customers in California?",
    );
    assert.equal(
      out.find((l) => l.type === "reference-line"),
      undefined,
    );
  });

  it("attaches with currency symbol even without suffix", () => {
    const out = inferAutoLayers(barChart(), "Are we above the $100 target?");
    const ref = out.find((l) => l.type === "reference-line");
    assert.ok(ref);
    assert.equal(ref!.value, 100);
  });

  // Fix-2 · mark-type gate
  it("does NOT attach reference-line on heatmap / treemap / radar", () => {
    const heatmap = inferAutoLayers(
      heatmapChart(),
      "Are we above the $100K target?",
    );
    assert.equal(
      heatmap.find((l) => l.type === "reference-line"),
      undefined,
    );
  });
});

describe("autoAttachLayers · trend / forecast on time series", () => {
  it("adds a trend layer on a line chart with trend keyword", () => {
    const out = inferAutoLayers(lineChart(), "How is revenue trending?");
    assert.ok(out.find((l) => l.type === "trend"));
  });

  it("adds forecast when projection language is used", () => {
    const out = inferAutoLayers(
      lineChart(),
      "What's the trend and forecast for next 3 months?",
    );
    const fc = out.find((l) => l.type === "forecast");
    assert.ok(fc);
    assert.equal(fc!.horizon, 4);
    assert.equal(fc!.method, "linear");
    assert.equal(fc!.ci, 0.95);
  });

  it("does NOT add trend on a bar chart even with trend keyword", () => {
    const out = inferAutoLayers(barChart(), "trending revenue?");
    assert.equal(out.find((l) => l.type === "trend"), undefined);
  });
});

describe("autoAttachLayers · outliers + comparison", () => {
  it("adds outlier layer on time-series with outlier keyword", () => {
    const out = inferAutoLayers(
      lineChart(),
      "Any anomalies in monthly revenue?",
    );
    const o = out.find((l) => l.type === "outliers");
    assert.ok(o);
    assert.equal(o!.threshold, 2);
  });

  it("adds comparison overlay on YoY phrasing", () => {
    const out = inferAutoLayers(
      lineChart(),
      "Show revenue trend year-over-year",
    );
    const c = out.find((l) => l.type === "comparison");
    assert.ok(c);
    assert.equal(c!.against, "prior-period");
  });
});

describe("autoAttachLayers · false-positive narrowing (Fix-2)", () => {
  it("'diploma' / 'diplomat' / 'diphenyl' do not trigger outliers", () => {
    for (const q of [
      "What revenue do diploma holders generate over time?",
      "Trend of diplomat visa applications by month",
      "Diphenyl ether sales over time",
    ]) {
      const out = inferAutoLayers(lineChart(), q);
      assert.equal(
        out.find((l) => l.type === "outliers"),
        undefined,
        `false positive on: ${q}`,
      );
    }
  });

  it("'dip' / 'dips' / 'dipped' / 'dipping' DO trigger outliers", () => {
    for (const q of [
      "Was there a dip in revenue last quarter?",
      "Show dips in monthly orders",
      "Revenue dipped after Q3, anomalies?",
      "Sales are dipping in some months",
    ]) {
      const out = inferAutoLayers(lineChart(), q);
      assert.ok(out.find((l) => l.type === "outliers"), `missed: ${q}`);
    }
  });

  it("caps very long input messages without throwing", () => {
    const huge = "target of 10K. " + "x".repeat(10_000);
    const out = inferAutoLayers(barChart(), huge);
    assert.ok(out.find((l) => l.type === "reference-line"));
  });
});

describe("autoAttachLayers · kill switch (Fix-2)", () => {
  it("AUTO_ATTACH_LAYERS_ENABLED=false returns chart unchanged", () => {
    const prev = process.env.AUTO_ATTACH_LAYERS_ENABLED;
    process.env.AUTO_ATTACH_LAYERS_ENABLED = "false";
    try {
      const c = lineChart();
      const out = attachAutoLayers(c, "How is revenue trending?");
      assert.equal(out._autoLayers, undefined);
    } finally {
      if (prev === undefined) delete process.env.AUTO_ATTACH_LAYERS_ENABLED;
      else process.env.AUTO_ATTACH_LAYERS_ENABLED = prev;
    }
  });
});

describe("autoAttachLayers · attach()", () => {
  it("populates _autoLayers when inferences exist", () => {
    const chart = attachAutoLayers(
      lineChart(),
      "How is revenue trending? Forecast next quarter.",
    );
    assert.ok(chart._autoLayers && chart._autoLayers.length >= 2);
  });

  it("preserves existing _autoLayers (no overwrite)", () => {
    const c = lineChart();
    c._autoLayers = [{ type: "annotation", text: "preset" }];
    const out = attachAutoLayers(c, "trending forecast next quarter");
    assert.equal(out._autoLayers!.length, 1);
    assert.equal(out._autoLayers![0]!.type, "annotation");
  });

  it("returns unchanged when nothing applies", () => {
    const out = attachAutoLayers(barChart(), "List the regions");
    assert.equal(out._autoLayers, undefined);
  });
});
