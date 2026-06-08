/**
 * Wave T4 · resolvePeriodAxis is span-aware: when the source date column's
 * dateRange (full-dataset span, populated at upload) implies a fine grain, the
 * default pick prefers that grain instead of the hard month-first preference.
 * Explicit question intent still wins; no dateRange → legacy month-first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePeriodAxis } from "../lib/periodColumnResolver.js";
import type { DataSummary } from "../shared/schema.js";

const COLUMNS = [
  "Day · Period",
  "Week · Period",
  "Month · Period",
  "Quarter · Period",
  "Year · Period",
];

const SAMPLE = Array.from({ length: 6 }, (_, i) => ({
  "Day · Period": `2026-04-${String(i + 1).padStart(2, "0")}`,
  "Week · Period": `2026-W${14 + i}`,
  "Month · Period": `2026-${String((i % 3) + 1).padStart(2, "0")}`,
  "Quarter · Period": `2026-Q${(i % 4) + 1}`,
  "Year · Period": `${2020 + i}`,
}));

function summaryWithRange(range?: {
  minIso: string;
  maxIso: string;
  distinctDayCount: number;
  spanDays: number;
}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 1,
    columns: [{ name: "Period", type: "date", sampleValues: [], ...(range ? { dateRange: range } : {}) }],
    numericColumns: [],
    dateColumns: ["Period"],
  } as unknown as DataSummary;
}

describe("Wave T4 · resolvePeriodAxis span-aware default", () => {
  it("single-month daily span → prefers Day grain (not month-first)", () => {
    const d = resolvePeriodAxis(
      COLUMNS,
      SAMPLE,
      summaryWithRange({ minIso: "2026-04-01", maxIso: "2026-04-30", distinctDayCount: 30, spanDays: 29 }),
    );
    assert.equal(d.pickedColumn, "Day · Period");
  });

  it("multi-year span → prefers Month grain", () => {
    const d = resolvePeriodAxis(
      COLUMNS,
      SAMPLE,
      summaryWithRange({ minIso: "2023-01-01", maxIso: "2025-12-31", distinctDayCount: 1000, spanDays: 365 * 3 }),
    );
    assert.equal(d.pickedColumn, "Month · Period");
  });

  it("explicit 'quarterly' intent still wins over the span recommendation", () => {
    const d = resolvePeriodAxis(
      COLUMNS,
      SAMPLE,
      summaryWithRange({ minIso: "2026-04-01", maxIso: "2026-04-30", distinctDayCount: 30, spanDays: 29 }),
      "show me quarterly sales",
    );
    assert.equal(d.pickedColumn, "Quarter · Period");
  });

  it("no dateRange → legacy month-first default (back-compat)", () => {
    const d = resolvePeriodAxis(COLUMNS, SAMPLE, summaryWithRange());
    assert.equal(d.pickedColumn, "Month · Period");
  });
});
