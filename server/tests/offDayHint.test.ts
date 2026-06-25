/**
 * W4 · computeOffDayHint — the transient hint that drives the non-blocking
 * "exclude Sundays?" affordance. Runs the existing off-day detector on a chart's
 * aggregated rows and returns { offWeekdays, summary } | null.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOffDayHint } from "../lib/insightGenerator/weekdayPattern.js";

// 4 weeks from Monday 2026-04-06; Sundays sit at ~0, other days ~5000.
function dailyRows(): { Date: string; Visits: number }[] {
  const rows: { Date: string; Visits: number }[] = [];
  const start = new Date(2026, 3, 6); // Mon 2026-04-06
  for (let i = 0; i < 28; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const isSunday = d.getDay() === 0;
    rows.push({ Date: iso, Visits: isSunday ? 0 : 4800 + (i % 5) * 100 });
  }
  return rows;
}

describe("computeOffDayHint", () => {
  it("flags Sunday as a recurring off-day on a daily date axis", () => {
    const hint = computeOffDayHint(dailyRows(), {
      x: "Date",
      y: "Visits",
      type: "line",
    });
    assert.ok(hint, "expected an off-day hint");
    assert.deepStrictEqual(hint.offWeekdays, ["Sunday"]);
    assert.match(hint.summary, /Sunday/);
    assert.match(hint.summary, /on other days/);
  });

  it("returns null when there is no recurring off-day (every day similar)", () => {
    const rows = dailyRows().map((r) => ({ ...r, Visits: 5000 }));
    assert.strictEqual(computeOffDayHint(rows, { x: "Date", y: "Visits", type: "line" }), null);
  });

  it("returns null for multi-series charts (seriesKeys present)", () => {
    const hint = computeOffDayHint(dailyRows(), {
      x: "Date",
      y: "Visits",
      type: "line",
      seriesKeys: ["North", "South"],
    });
    assert.strictEqual(hint, null);
  });

  it("returns null for dual-axis (y2) and heatmap charts", () => {
    assert.strictEqual(
      computeOffDayHint(dailyRows(), { x: "Date", y: "Visits", type: "line", y2: "Other" }),
      null
    );
    assert.strictEqual(
      computeOffDayHint(dailyRows(), { x: "Date", y: "Visits", type: "heatmap" }),
      null
    );
  });

  it("returns null when x/y missing", () => {
    assert.strictEqual(computeOffDayHint(dailyRows(), { x: "Date", type: "line" }), null);
  });

  it("returns null on a non-daily (monthly) axis — no weekday rhythm", () => {
    const rows = [
      { Month: "2026-01", Visits: 100 },
      { Month: "2026-02", Visits: 120 },
      { Month: "2026-03", Visits: 90 },
      { Month: "2026-04", Visits: 110 },
    ];
    assert.strictEqual(computeOffDayHint(rows, { x: "Month", y: "Visits", type: "line" }), null);
  });
});
