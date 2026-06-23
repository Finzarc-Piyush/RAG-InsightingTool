/**
 * buildTrendTemporalCompanions — a pointed daily-trend ask gets the SAME measure
 * re-aggregated at coarser grains (Day → Week → Month), span-gated, and nothing
 * else. This is the positive half of the "pointed trend → pointed answer" fix.
 *
 * Pins: weekly only when data spans >2 weeks; monthly only when >2 months; the
 * companion is sum-preserving for a sum metric; no cross-dimension breakdowns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTrendTemporalCompanions } from "../lib/agents/runtime/visualPlanner.js";
import type { ChartSpec } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

/** Daily {x,y} points from `start` for `days` days, value = index+1. */
function dailyPoints(start: string, days: number): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const base = new Date(`${start}T00:00:00`);
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ "Day · Date": iso, visits_sum: i + 1 });
  }
  return out;
}

function makeCtx(data: Record<string, any>[]): AgentExecutionContext {
  return {
    summary: { dateColumns: ["Date"], columns: [], numericColumns: [] },
    question: "what is the daily trend in visits?",
    mode: "analysis",
  } as unknown as AgentExecutionContext;
}

function primaryDaily(data: Record<string, any>[]): ChartSpec {
  return {
    type: "line",
    title: "visits_sum by Day · Date",
    x: "Day · Date",
    y: "visits_sum",
    aggregate: "sum",
    data,
  } as ChartSpec;
}

const dailySum = (data: Record<string, any>[]) =>
  data.reduce((s, r) => s + (r.visits_sum as number), 0);

describe("buildTrendTemporalCompanions", () => {
  it("one month of daily data → Weekly companion only (no Monthly), sum-preserving", () => {
    const data = dailyPoints("2026-04-01", 30); // ~5 ISO weeks, 1 month
    const ctx = makeCtx(data);
    const companions = buildTrendTemporalCompanions(ctx, [primaryDaily(data)]);

    assert.equal(companions.length, 1, "exactly the weekly companion");
    const wk = companions[0]!;
    assert.equal(wk.x, "Week · Date");
    assert.equal(wk.y, "visits_sum");
    assert.equal(wk.type, "line");
    assert.equal(
      (wk.data ?? []).reduce((s, r) => s + (r.visits_sum as number), 0),
      dailySum(data),
      "weekly totals preserve the daily sum"
    );
    assert.ok((wk.data ?? []).length > 2, "more than 2 week buckets");
  });

  it("three months of daily data → BOTH Weekly and Monthly companions", () => {
    const data = dailyPoints("2026-01-01", 90); // 3 months
    const companions = buildTrendTemporalCompanions(makeCtx(data), [
      primaryDaily(data),
    ]);
    const xs = companions.map((c) => c.x).sort();
    assert.deepEqual(xs, ["Month · Date", "Week · Date"]);
    const month = companions.find((c) => c.x === "Month · Date")!;
    assert.ok(
      (month.data ?? []).length >= 3,
      "at least 3 month buckets present"
    );
    assert.equal(
      (month.data ?? []).reduce((s, r) => s + (r.visits_sum as number), 0),
      dailySum(data),
      "monthly totals preserve the daily sum"
    );
  });

  it("only two weeks of daily data → NO companions (span gate)", () => {
    const data = dailyPoints("2026-04-06", 10); // within 2 ISO weeks, 1 month
    const companions = buildTrendTemporalCompanions(makeCtx(data), [
      primaryDaily(data),
    ]);
    assert.equal(companions.length, 0);
  });

  it("mean metric → companion averages (not sums) the daily values", () => {
    const data = dailyPoints("2026-04-01", 30);
    const primary = { ...primaryDaily(data), aggregate: "mean" } as ChartSpec;
    const companions = buildTrendTemporalCompanions(makeCtx(data), [primary]);
    assert.equal(companions.length, 1);
    const wk = companions[0]!;
    // Each weekly point must be within the daily min/max range (an average, not a sum).
    const maxDaily = Math.max(...data.map((r) => r.visits_sum as number));
    for (const r of wk.data ?? []) {
      assert.ok((r.visits_sum as number) <= maxDaily, "weekly mean ≤ daily max");
    }
  });

  it("no primary daily chart → no companions", () => {
    const data = dailyPoints("2026-04-01", 30);
    const barOnDim = {
      type: "bar",
      title: "visits by Cluster",
      x: "Cluster",
      y: "visits_sum",
      data: [{ Cluster: "North", visits_sum: 5 }],
    } as ChartSpec;
    assert.equal(
      buildTrendTemporalCompanions(makeCtx(data), [barOnDim]).length,
      0
    );
  });
});
