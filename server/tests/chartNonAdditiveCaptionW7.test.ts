import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finishChartSpec } from "../lib/chartSpecFinish.js";
import type { ChartSpec } from "../shared/schema.js";

/**
 * W7 · a non-additive metric chart must tell the user the bars are a weighted
 * average, not a total — surfaced via the existing axisReason subtitle so no
 * client change is needed. An additive chart gets no such note.
 */
describe("finishChartSpec — non-additive aggregation caption", () => {
  const rows = [{ Channel: "GT", "GC%": 30 }, { Channel: "MT", "GC%": 60 }];

  it("adds a weighted-average note for a non-additive (weighted_mean) chart", () => {
    const spec = {
      type: "bar", x: "Channel", y: "GC%", title: "GC% by Channel",
      metricAdditivity: "non_additive", aggPolicy: "weighted_mean",
    } as unknown as ChartSpec;
    const out = finishChartSpec(spec, rows);
    assert.match(out.axisReason ?? "", /ratio/i);
    assert.match(out.axisReason ?? "", /weighted average/i);
    assert.match(out.axisReason ?? "", /not a sum/i);
  });

  it("adds NO note for an additive (sum) chart", () => {
    const spec = {
      type: "bar", x: "Channel", y: "Net Revenue", title: "NR by Channel",
      metricAdditivity: "additive", aggPolicy: "sum",
    } as unknown as ChartSpec;
    const out = finishChartSpec(spec, [{ Channel: "GT", "Net Revenue": 200 }]);
    assert.equal(out.axisReason, undefined);
  });

  it("appends to an existing axisReason rather than clobbering it", () => {
    const spec = {
      type: "line", x: "Month", y: "GC%", title: "GC% trend", axisReason: "Showing Month · Date.",
      metricAdditivity: "non_additive", aggPolicy: "weighted_mean",
    } as unknown as ChartSpec;
    const out = finishChartSpec(spec, [{ Month: "2026-01", "GC%": 30 }]);
    assert.match(out.axisReason ?? "", /^Showing Month · Date\./);
    assert.match(out.axisReason ?? "", /weighted average/i);
  });
});
