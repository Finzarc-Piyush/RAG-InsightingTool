import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

/**
 * W5 · the "sum of GC% for 6 channels" fix. A ratio metric must NEVER be summed
 * across a dimension. With its parts (GC, NR) on the frame it is recomputed
 * Σnum/Σden per group; otherwise it averages; additive metrics still SUM.
 */
const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("processChartData — non-additive aggregation", () => {
  // Two regions per channel, so each channel group has MULTIPLE rows — the case
  // where the old none→sum coercion produced a nonsense inflated GC%.
  const rows = [
    { Channel: "GT", Region: "N", GC: 40, "Net Revenue": 100, "GC%": 40 },
    { Channel: "GT", Region: "S", GC: 20, "Net Revenue": 100, "GC%": 20 },
    { Channel: "MT", Region: "N", GC: 60, "Net Revenue": 100, "GC%": 60 },
    { Channel: "MT", Region: "S", GC: 30, "Net Revenue": 50, "GC%": 60 },
  ];

  it("combines GC% by channel as a NR-weighted mean — scale-preserving, not summed", () => {
    const spec = { type: "bar", x: "Channel", y: "GC%", title: "GC% by channel" } as unknown as ChartSpec;
    const out = processChartData(rows, spec);
    const byChannel = Object.fromEntries(out.map((r) => [r.Channel, round(r["GC%"])]));
    // GT: (40·100 + 20·100)/200 = 30   MT: (60·100 + 60·50)/150 = 60 (percent-points kept)
    assert.equal(byChannel.GT, 30);
    assert.equal(byChannel.MT, 60);
    // Definitely NOT the sum (60) and on the source percent scale (not the 0.30 fraction).
    assert.notEqual(byChannel.GT, 60);
    assert.equal(spec.metricAdditivity, "non_additive");
    assert.equal(spec.aggPolicy, "weighted_mean");
  });

  it("falls back to mean (never sum) when the components are absent", () => {
    const ratioOnly = rows.map(({ Channel, "GC%": pct }) => ({ Channel, "GC%": pct }));
    const spec = { type: "bar", x: "Channel", y: "GC%", title: "GC% by channel" } as unknown as ChartSpec;
    const out = processChartData(ratioOnly, spec);
    const byChannel = Object.fromEntries(out.map((r) => [r.Channel, round(r["GC%"])]));
    assert.equal(byChannel.GT, 30); // mean(40,20)
    assert.equal(byChannel.MT, 60); // mean(60,60)
    assert.equal(spec.aggPolicy, "mean");
  });

  it("still SUMs an additive metric (no regression)", () => {
    const spec = { type: "bar", x: "Channel", y: "Net Revenue", title: "NR by channel" } as unknown as ChartSpec;
    const out = processChartData(rows, spec);
    const byChannel = Object.fromEntries(out.map((r) => [r.Channel, round(r["Net Revenue"])]));
    assert.equal(byChannel.GT, 200); // 100 + 100
    assert.equal(byChannel.MT, 150); // 100 + 50
    assert.equal(spec.metricAdditivity, "additive");
    assert.equal(spec.aggPolicy, "sum");
  });

  it("a pre-aggregated one-row-per-channel ratio frame is emitted verbatim (no double-aggregation)", () => {
    const pre = [
      { Channel: "GT", "GC%": 30 },
      { Channel: "MT", "GC%": 60 },
    ];
    const spec = { type: "bar", x: "Channel", y: "GC%", title: "GC% by channel" } as unknown as ChartSpec;
    const out = processChartData(pre, spec);
    const byChannel = Object.fromEntries(out.map((r) => [r.Channel, round(r["GC%"])]));
    assert.equal(byChannel.GT, 30);
    assert.equal(byChannel.MT, 60);
  });

  it("a non-additive multi-series bar is forced grouped, never stacked", () => {
    const spec = {
      type: "bar",
      x: "Channel",
      y: "GC%",
      seriesColumn: "Region",
      barLayout: "stacked",
      title: "GC% by channel × region",
    } as unknown as ChartSpec;
    processChartData(rows, spec);
    assert.equal(spec.barLayout, "grouped");
  });
});
