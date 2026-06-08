// Wave T4/T5 · compute_growth facet guard — if a hand-crafted step passes a
// temporal FACET ("Month · Date") as the period axis and that grain collapses
// to a single bucket for the data span, the tool prefers the raw daily source
// axis so the trend has ≥2 points. Multi-bucket facets are left as-is.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerComputeGrowthTool } from "../lib/agents/runtime/tools/computeGrowthTool.js";
import type { DataSummary } from "../shared/schema.js";

function summaryWithFacet(dateRange: {
  minIso: string;
  maxIso: string;
  distinctDayCount: number;
  spanDays: number;
}): DataSummary {
  return {
    rowCount: 30,
    columnCount: 3,
    columns: [
      { name: "Date", type: "date", sampleValues: ["2026-04-01"], dateRange },
      { name: "Month · Date", type: "string", sampleValues: ["2026-04"] },
      { name: "Sales", type: "number", sampleValues: [100] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Date"],
  } as unknown as DataSummary;
}

/** Daily rows across [aprDays] of April and [mayDays] of May 2026. */
function rows(aprDays: number, mayDays = 0): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let v = 100;
  for (let d = 1; d <= aprDays; d++) {
    const dd = String(d).padStart(2, "0");
    out.push({ Date: `2026-04-${dd}`, "Month · Date": "2026-04", Sales: (v += 5) });
  }
  for (let d = 1; d <= mayDays; d++) {
    const dd = String(d).padStart(2, "0");
    out.push({ Date: `2026-05-${dd}`, "Month · Date": "2026-05", Sales: (v += 5) });
  }
  return out;
}

function makeCtx(summary: DataSummary, data: Record<string, unknown>[]): any {
  return { exec: { mode: "analysis", summary, data, sessionId: "t" }, config: {} };
}

describe("Wave T5 · compute_growth facet guard", () => {
  it("collapsing Month facet → falls back to the raw daily axis (30 points)", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(
      summaryWithFacet({ minIso: "2026-04-01", maxIso: "2026-04-30", distinctDayCount: 30, spanDays: 29 }),
      rows(30),
    );
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", periodIsoColumn: "Month · Date", mode: "trend" },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_mode, "trend");
    assert.equal(out.memorySlots?.growth_n_periods, "30");
    assert.doesNotMatch(out.summary, /single period/i);
  });

  it("multi-bucket Month facet (2 months) is left as-is (2 points)", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(
      summaryWithFacet({ minIso: "2026-04-01", maxIso: "2026-05-31", distinctDayCount: 61, spanDays: 60 }),
      rows(30, 31),
    );
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", periodIsoColumn: "Month · Date", mode: "trend" },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_n_periods, "2"); // stayed on the month facet
  });

  it("no dateRange metadata → facet untouched (cannot prove collapse)", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const summary = summaryWithFacet({ minIso: "2026-04-01", maxIso: "2026-04-30", distinctDayCount: 30, spanDays: 29 });
    (summary.columns[0] as any).dateRange = undefined; // strip the span
    const ctx = makeCtx(summary, rows(30));
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", periodIsoColumn: "Month · Date", mode: "trend" },
      ctx,
    );
    assert.equal(out.ok, true);
    // Facet kept → single month bucket → single-period (graceful, not a crash).
    assert.equal(out.memorySlots?.growth_n_periods, "1");
  });
});
