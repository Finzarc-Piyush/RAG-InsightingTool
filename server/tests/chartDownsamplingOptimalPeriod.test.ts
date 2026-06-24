// Wave W-XAX2 · the custom Build-Chart preview's auto period now delegates to the
// centralized temporal-grain authority (invariant #11). The old local ladder in
// determineOptimalPeriod snapped any span > 14 days to WEEK, so a single month of
// daily data rendered as weekly buckets in the chart builder — diverging from every
// agent-built trend chart (≤90-day spans stay at DAY grain). These tests lock the
// span→grain decision to pickTrendGrainForSpan via inferOptimalPeriodForChartColumn.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferOptimalPeriodForChartColumn } from "../lib/chartDownsampling.js";

function dailyRows(days: number, startIso = "2026-04-01"): Record<string, any>[] {
  const start = new Date(startIso + "T00:00:00");
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    return { Date: iso, Sales: 100 + i };
  });
}

describe("inferOptimalPeriodForChartColumn · delegates to temporal grain authority", () => {
  it("a full month of daily data resolves to DAY, not WEEK (the reported bug)", () => {
    // 30 daily rows, 2026-04-01 → 2026-04-30 (~29-day span). The old ladder said
    // 'week' (days > 14); the authority keeps ≤90-day spans at day grain.
    const period = inferOptimalPeriodForChartColumn(dailyRows(30), "Date");
    assert.equal(period, "day");
  });

  it("a ~90-day daily span stays at DAY grain (authority's day ceiling)", () => {
    const period = inferOptimalPeriodForChartColumn(dailyRows(90), "Date");
    assert.equal(period, "day");
  });

  it("a ~6-month span resolves to WEEK", () => {
    // ~180 days → > 90, ≤ 365 → week.
    const period = inferOptimalPeriodForChartColumn(dailyRows(180), "Date");
    assert.equal(period, "week");
  });

  it("a multi-year span resolves to MONTH", () => {
    // 2 years of weekly-ish points (span > 365, ≤ 5y) → month.
    const rows = Array.from({ length: 105 }, (_, i) => {
      const d = new Date("2026-01-01T00:00:00");
      d.setDate(d.getDate() + i * 7);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
      return { Date: iso, Sales: i };
    });
    assert.equal(inferOptimalPeriodForChartColumn(rows, "Date"), "month");
  });

  it("returns null when fewer than two parseable dates exist", () => {
    assert.equal(inferOptimalPeriodForChartColumn([{ Date: "2026-04-01" }], "Date"), null);
    assert.equal(
      inferOptimalPeriodForChartColumn(
        [{ Date: "not-a-date" }, { Date: "also-not" }],
        "Date",
      ),
      null,
    );
  });

  it("a single repeated day (degenerate span) does not fabricate a day axis", () => {
    // distinctDayCount <= 1 → authority returns 'month' so the caller falls through
    // rather than plotting one fake daily point.
    const rows = [
      { Date: "2026-04-10", Sales: 1 },
      { Date: "2026-04-10", Sales: 2 },
    ];
    assert.equal(inferOptimalPeriodForChartColumn(rows, "Date"), "month");
  });
});
