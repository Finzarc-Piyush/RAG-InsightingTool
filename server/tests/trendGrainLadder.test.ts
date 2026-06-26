/**
 * Wave 3 — multi-grain trend ladder.
 *
 * (a) resolveTrendGrainLadder: the span→grain-ladder authority. Drops the
 *     coarsest 1-bucket level and over-fine grains. ~1 month → [week, date];
 *     ~1 year → [quarter, month].
 * (b) applyTrendGrainLadder: the post-merge pass that swaps a single-grain
 *     anchor trend for the ladder, honouring a pinned grain and the depth gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrendGrainLadder,
  type DateRange,
} from "../lib/temporalGrainAuthority.js";
import { applyTrendGrainLadder } from "../lib/agents/runtime/trendGrainLadder.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { ChartSpec, DataSummary } from "../shared/schema.js";

function rangeFor(minIso: string, maxIso: string, distinctDayCount: number): DateRange {
  const ms = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
  return {
    minIso,
    maxIso,
    distinctDayCount,
    spanDays: Math.round((ms(maxIso) - ms(minIso)) / 86_400_000),
  };
}

describe("resolveTrendGrainLadder", () => {
  it("~1 month of data → weekly + daily (no 1-bucket monthly)", () => {
    const ladder = resolveTrendGrainLadder(rangeFor("2024-04-01", "2024-04-30", 30));
    assert.deepStrictEqual(ladder, ["week", "date"]);
  });

  it("~1 year of data → quarterly + monthly only (no weekly/daily, no yearly)", () => {
    const ladder = resolveTrendGrainLadder(rangeFor("2024-01-01", "2024-12-31", 366));
    assert.deepStrictEqual(ladder, ["quarter", "month"]);
  });

  it("degenerate single-period span → empty (caller keeps single grain)", () => {
    assert.deepStrictEqual(resolveTrendGrainLadder(rangeFor("2024-04-01", "2024-04-02", 2)), []);
  });

  it("multi-year span → up to three coarse levels", () => {
    const ladder = resolveTrendGrainLadder(rangeFor("2022-01-01", "2024-12-31", 1096));
    assert.deepStrictEqual(ladder, ["year", "quarter", "month"]);
  });
});

// ── applyTrendGrainLadder ──────────────────────────────────────────────────

function dailyRows(days: number, col = "Date", metric = "PJP Adherence"): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const start = new Date("2024-04-01T00:00:00");
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    rows.push({ [col]: iso, [metric]: i % 3 === 0 ? "Yes" : "No" });
  }
  return rows;
}

function indicatorSummary(metric = "PJP Adherence", dateCol = "Date"): DataSummary {
  return {
    rowCount: 30,
    columnCount: 2,
    columns: [
      { name: dateCol, type: "date", sampleValues: ["2024-04-01"] },
      {
        name: metric,
        type: "string",
        sampleValues: ["Yes"],
        indicator: {
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          sentinelValues: [],
          source: "auto",
        },
      },
    ],
    numericColumns: [],
    dateColumns: [dateCol],
  } as unknown as DataSummary;
}

function ctxFor(
  question: string,
  rows: Record<string, unknown>[],
  summary: DataSummary,
  extra: Partial<AgentExecutionContext> = {}
): AgentExecutionContext {
  return {
    question,
    summary,
    data: rows,
    turnStartDataRef: rows,
    depthBudget: "full",
    analysisBrief: { requestsDashboard: true, outcomeMetricColumn: "PJP Adherence" },
    queryIntent: { signals: { trend: false } },
    ...extra,
  } as unknown as AgentExecutionContext;
}

const monthlyTrend = (metric = "PJP Adherence"): ChartSpec =>
  ({
    type: "line",
    title: `${metric} by Month · Date`,
    x: "Month · Date",
    y: metric,
    data: [{ "Month · Date": "Apr 2024", [metric]: 0.33 }],
  }) as unknown as ChartSpec;

describe("applyTrendGrainLadder", () => {
  it("replaces a 1-bucket monthly PJP trend with weekly + daily on a month of data", () => {
    const rows = dailyRows(30);
    const ctx = ctxFor("build a PJP dashboard", rows, indicatorSummary());
    const out = applyTrendGrainLadder(ctx, [monthlyTrend()]);
    const trendXs = out.map((c) => c.x).sort();
    assert.deepStrictEqual(trendXs, ["Day · Date", "Week · Date"]);
    // It is the anchor metric, rendered as a per-period rate.
    assert.ok(out.every((c) => c.y === "PJP Adherence"));
    assert.ok(!out.some((c) => c.x === "Month · Date"), "1-bucket monthly dropped");
  });

  it("keeps unrelated charts and only swaps the anchor trend", () => {
    const rows = dailyRows(30);
    const ctx = ctxFor("build a PJP dashboard", rows, indicatorSummary());
    const byRegion = { type: "bar", title: "PJP by Region", x: "Region", y: "PJP Adherence", data: [] } as unknown as ChartSpec;
    const out = applyTrendGrainLadder(ctx, [monthlyTrend(), byRegion]);
    assert.ok(out.includes(byRegion), "non-temporal breakdown preserved");
    assert.ok(out.some((c) => c.x === "Day · Date"));
  });

  it("respects a PINNED grain: 'daily' → no ladder expansion", () => {
    const rows = dailyRows(30);
    const ctx = ctxFor("show me the daily PJP chart", rows, indicatorSummary(), {
      queryIntent: { signals: { trend: true } },
    });
    const seed = [monthlyTrend()];
    const out = applyTrendGrainLadder(ctx, seed);
    assert.strictEqual(out, seed, "unchanged when the user pinned a grain");
  });

  it("is a no-op at minimal depth", () => {
    const rows = dailyRows(30);
    const ctx = ctxFor("build a PJP dashboard", rows, indicatorSummary(), {
      depthBudget: "minimal",
    });
    const seed = [monthlyTrend()];
    assert.strictEqual(applyTrendGrainLadder(ctx, seed), seed);
  });
});
