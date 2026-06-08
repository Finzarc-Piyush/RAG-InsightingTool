// WGR4 · compute_growth "trend" mode + auto-fallback — pins the intra-span
// trajectory path that answers "how has X trended over time?" on a single
// contiguous span (e.g. 30 daily rows within one month), where calendar
// period-over-period growth is undefined. Exercises the in-memory path
// (no columnar store), mirroring computeGrowthTool.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerComputeGrowthTool } from "../lib/agents/runtime/tools/computeGrowthTool.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";
import { assessConfidence } from "../lib/agents/runtime/scaleNarrativeByConfidence.js";
import type { DataSummary } from "../shared/schema.js";

function makeDailySummary(): DataSummary {
  return {
    rowCount: 30,
    columnCount: 2,
    columns: [
      { name: "Date", type: "date", sampleValues: ["2026-04-01"] },
      { name: "Sales", type: "number", sampleValues: [100] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Date"],
  };
}

/** 30 daily rows in April 2026; value comes from valueFn(dayNumber 1..30). */
function dailyRows(
  valueFn: (day: number) => number,
  withTime = false,
  days = 30
): Record<string, unknown>[] {
  return Array.from({ length: days }, (_, i) => {
    const dd = String(i + 1).padStart(2, "0");
    return {
      Date: `2026-04-${dd}${withTime ? "T00:00:00" : ""}`,
      Sales: valueFn(i + 1),
    };
  });
}

function makeCtx(data: Record<string, unknown>[]): any {
  return {
    exec: {
      mode: "analysis",
      summary: makeDailySummary(),
      data,
      sessionId: "test-session",
      // No columnarStoragePath ⇒ in-memory path.
    },
    config: {},
  };
}

const TREND_COLUMNS = ["period", "value", "prior_value", "growth_pct", "growth_abs"];

describe("WGR4 · compute_growth · explicit trend mode", () => {
  it("rising daily series → direction rising, trajectory slots, growth pairs", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 100 + d * 5)); // 105 → 250
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_mode, "trend");
    assert.equal(out.memorySlots?.growth_direction, "rising");
    assert.equal(out.memorySlots?.growth_n_periods, "30");
    assert.equal(out.memorySlots?.growth_peak_period, "2026-04-30");
    assert.equal(out.memorySlots?.growth_trough_period, "2026-04-01");
    assert.match(out.summary, /rose/);
    assert.doesNotMatch(out.summary, /cannot be shown|no prior-period pairs/i);
    const rows = out.table?.rows as Array<{ growth_pct: number | null }>;
    assert.equal(rows.length, 30);
    assert.equal(rows[0].growth_pct, null); // first has no predecessor
    assert.ok(typeof rows[1].growth_pct === "number"); // consecutive delta
    assert.deepEqual(out.table?.columns, TREND_COLUMNS);
  });

  it("falling daily series → direction falling", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 1000 - d * 10)); // 990 → 700
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_direction, "falling");
    assert.match(out.summary, /fell/);
  });

  it("flat daily series → direction flat, R²≈0", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows(() => 500));
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_direction, "flat");
    assert.equal(out.memorySlots?.growth_trend_r2, "0.000");
    assert.match(out.summary, /flat/);
  });

  it("raw timestamps (with time component) still sort and trend", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 100 + d * 5, true));
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_direction, "rising");
    assert.equal(out.memorySlots?.growth_n_periods, "30");
  });

  it("single period → graceful summary, no defeatist string", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 100 + d, false, 1)); // one row → one period
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.match(out.summary, /single period/);
    assert.equal(out.memorySlots?.growth_n_periods, "1");
    assert.equal(out.memorySlots?.growth_direction, undefined);
  });
});

describe("WGR4 · compute_growth · auto-fallback (the bug scenario)", () => {
  it("summary+auto on daily single-month data falls back to a trajectory, not a refusal", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 100 + d * 3)); // rising
    const out = await reg.execute(
      "compute_growth",
      // The exact call the skill made: summary mode, grain auto, daily data.
      { metricColumn: "Sales", dateColumn: "Date", grain: "auto", mode: "summary" },
      ctx
    );
    assert.equal(out.ok, true);
    // Must NOT be the old defeatist refusal.
    assert.doesNotMatch(
      out.summary,
      /no prior-period pairs available|insufficient temporal coverage|cannot be shown/i
    );
    // Must be a real within-window trajectory via auto-fallback.
    assert.equal(out.memorySlots?.growth_mode, "trend");
    assert.equal(out.memorySlots?.growth_direction, "rising");
    assert.match(out.summary, /trend, auto/);
    assert.match(out.summary, /rose/);
  });
});

describe("WGR4 · compute_growth · trend feeds the confidence grader", () => {
  it("trend summary exposes n + R² so the finding is tiered on fit, not defaulted", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(dailyRows((d) => 100 + d * 5)); // perfectly linear → R²≈1
    const out = await reg.execute(
      "compute_growth",
      { metricColumn: "Sales", dateColumn: "Date", mode: "trend" },
      ctx
    );
    const ev = extractFindingEvidence(out.summary);
    assert.equal(ev.n, 30, `n should be parsed from the summary; got ${ev.n}`);
    assert.ok(
      ev.rSquared !== undefined && ev.rSquared >= 0.99,
      `R² should be parsed; got ${ev.rSquared}`
    );
    const assessment = assessConfidence(ev);
    // A strong 30-point trend grades HIGH — not the "no evidence → medium" default.
    assert.equal(assessment.tier, "high");
    assert.ok(!assessment.reasons.includes("no statistical evidence supplied"));
  });
});
