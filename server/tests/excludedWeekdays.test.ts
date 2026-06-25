/**
 * W5 · Per-chart off-day exclusion. `excludedWeekdays` rides chartSpecSchema and
 * `filterRowsByExcludedWeekdays` drops those rows BEFORE aggregation — so a mean
 * divides by working-day count only (working-day-aware average, no special math).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterRowsByExcludedWeekdays } from "../lib/insightGenerator/weekdayPattern.js";
import { chartSpecSchema } from "../shared/schema/charts.js";

// Mon 2026-04-06 … 2 weeks; Sundays (04-12, 04-19) at 0, others at 4000.
function dailyRows(): { Date: string; Visits: number }[] {
  const rows: { Date: string; Visits: number }[] = [];
  const start = new Date(2026, 3, 6);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    rows.push({ Date: iso, Visits: d.getDay() === 0 ? 0 : 4000 });
  }
  return rows;
}

const mean = (rows: { Visits: number }[]) =>
  rows.reduce((s, r) => s + r.Visits, 0) / rows.length;

describe("filterRowsByExcludedWeekdays", () => {
  it("drops Sunday rows when x is a raw date column", () => {
    const rows = dailyRows();
    const out = filterRowsByExcludedWeekdays(rows, "Date", ["Date"], ["Sunday"]);
    assert.strictEqual(out.length, 12); // 14 − 2 Sundays
    assert.ok(out.every((r) => !r.Date.endsWith("04-12") && !r.Date.endsWith("04-19")));
  });

  it("makes the average working-day-aware (denominator drops off-days)", () => {
    const rows = dailyRows();
    const allDaysMean = mean(rows); // dragged down by the two 0-Sundays
    const workingMean = mean(filterRowsByExcludedWeekdays(rows, "Date", ["Date"], ["Sunday"]) as { Visits: number }[]);
    assert.ok(workingMean > allDaysMean, `working ${workingMean} should exceed all-days ${allDaysMean}`);
    assert.strictEqual(workingMean, 4000); // every remaining day is a working day
  });

  it("resolves the date column when x is another facet ('Day · Date')", () => {
    const rows = dailyRows();
    const out = filterRowsByExcludedWeekdays(rows, "Day · Date", ["Date"], ["Sunday"]);
    assert.strictEqual(out.length, 12);
  });

  it("filters directly when x IS the weekday facet ('Day of week · Date')", () => {
    const rows = dailyRows().map((r) => ({
      ...r,
      "Day of week · Date": new Date(r.Date).getDay() === 0 ? "Sunday" : "Weekday",
    }));
    const out = filterRowsByExcludedWeekdays(rows, "Day of week · Date", ["Date"], ["Sunday"]);
    assert.ok(out.every((r) => r["Day of week · Date"] !== "Sunday"));
  });

  it("keeps rows whose date can't be parsed (never silently drops)", () => {
    const rows = [{ Date: "n/a", Visits: 10 }, { Date: "2026-04-12", Visits: 0 }];
    const out = filterRowsByExcludedWeekdays(rows, "Date", ["Date"], ["Sunday"]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]!.Date, "n/a");
  });

  it("is a no-op with empty/absent exclusions or non-date x", () => {
    const rows = dailyRows();
    assert.strictEqual(filterRowsByExcludedWeekdays(rows, "Date", ["Date"], []).length, 14);
    assert.strictEqual(filterRowsByExcludedWeekdays(rows, "Region", ["Date"], ["Sunday"]).length, 14);
  });
});

describe("chartSpecSchema · excludedWeekdays round-trips", () => {
  it("accepts a valid weekday array and rejects junk", () => {
    const spec = chartSpecSchema.parse({
      type: "line",
      title: "t",
      x: "Date",
      y: "Visits",
      excludedWeekdays: ["Sunday"],
    });
    assert.deepStrictEqual(spec.excludedWeekdays, ["Sunday"]);
    assert.throws(() =>
      chartSpecSchema.parse({ type: "line", title: "t", x: "Date", y: "Visits", excludedWeekdays: ["Funday"] })
    );
  });
});
