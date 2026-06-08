// WGR4 · temporalCoverage tests — pin the shared scanner that decides
// whether calendar period-over-period growth is possible (vs. a single
// contiguous span that must route to sequential "trend") and whether there
// is enough history for seasonality.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanCalendarCoverage,
  hasMultiPeriodCalendarCoverage,
  hasSeasonalityCoverage,
} from "../lib/growth/temporalCoverage.js";

function dailyMonth(year: number, month: number, days: number, col = "Date") {
  const mm = String(month).padStart(2, "0");
  return Array.from({ length: days }, (_, i) => ({
    [col]: `${year}-${mm}-${String(i + 1).padStart(2, "0")}`,
  }));
}

describe("WGR4 · temporalCoverage", () => {
  it("one month of daily rows → single span (not multi-period)", () => {
    const cov = scanCalendarCoverage(dailyMonth(2026, 4, 30), "Date");
    assert.equal(cov.distinctYears, 1);
    assert.equal(cov.maxMonthsInOneYear, 1);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), false);
    assert.equal(hasSeasonalityCoverage(cov), false);
  });

  it("two distinct months of daily rows → multi-period", () => {
    const rows = [...dailyMonth(2026, 4, 30), ...dailyMonth(2026, 5, 30)];
    const cov = scanCalendarCoverage(rows, "Date");
    assert.equal(cov.maxMonthsInOneYear, 2);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), true);
  });

  it("raw timestamps with time component still bucket to month", () => {
    const rows = [
      { Date: "2026-04-01T00:00:00" },
      { Date: "2026-04-02T12:30:00" },
      { Date: "2026-05-01T00:00:00" },
    ];
    const cov = scanCalendarCoverage(rows, "Date");
    assert.equal(cov.maxMonthsInOneYear, 2);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), true);
  });

  it("YYYY-MM ISO labels across 5 years × 12 months → seasonality coverage", () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let y = 2021; y <= 2025; y++)
      for (let m = 1; m <= 12; m++)
        rows.push({ PeriodIso: `${y}-${String(m).padStart(2, "0")}` });
    const cov = scanCalendarCoverage(rows, "PeriodIso");
    assert.equal(cov.distinctYears, 5);
    assert.equal(cov.maxMonthsInOneYear, 12);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), true);
    assert.equal(hasSeasonalityCoverage(cov), true);
  });

  it("single year of 4 quarters → multi-period but not seasonality", () => {
    const rows = [
      { PeriodIso: "2026-Q1" },
      { PeriodIso: "2026-Q2" },
      { PeriodIso: "2026-Q3" },
      { PeriodIso: "2026-Q4" },
    ];
    const cov = scanCalendarCoverage(rows, "PeriodIso");
    assert.equal(cov.maxQuartersInOneYear, 4);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), true);
    assert.equal(hasSeasonalityCoverage(cov), false); // needs ≥2 years
  });

  it("weekly ISO labels within one year → multi-period via weeks", () => {
    const rows = [
      { PeriodIso: "2026-W01" },
      { PeriodIso: "2026-W02" },
      { PeriodIso: "2026-W03" },
    ];
    const cov = scanCalendarCoverage(rows, "PeriodIso");
    assert.equal(cov.maxWeeksInOneYear, 3);
    assert.equal(hasMultiPeriodCalendarCoverage(cov), true);
  });

  it("empty data → all zero, no coverage", () => {
    const cov = scanCalendarCoverage([], "Date");
    assert.deepEqual(cov, {
      distinctYears: 0,
      maxMonthsInOneYear: 0,
      maxQuartersInOneYear: 0,
      maxWeeksInOneYear: 0,
    });
    assert.equal(hasMultiPeriodCalendarCoverage(cov), false);
  });
});
