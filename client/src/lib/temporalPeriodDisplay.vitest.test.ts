import { describe, it, expect } from "vitest";
import {
  formatTemporalPeriodKeyForDisplay,
  isCanonicalPeriodKey,
} from "@/lib/temporalPeriodDisplay";
import { sortRowsForLineAreaChart } from "@/lib/chartRechartsShared";
import { formatChartValue } from "@/lib/charts/format";

describe("formatTemporalPeriodKeyForDisplay", () => {
  it("renders quarters as quarters (never months)", () => {
    expect(formatTemporalPeriodKeyForDisplay("2023-Q1")).toBe("Q1 2023");
    expect(formatTemporalPeriodKeyForDisplay("2025-Q4")).toBe("Q4 2025");
  });
  it("renders every other grain", () => {
    expect(formatTemporalPeriodKeyForDisplay("2023")).toBe("2023");
    expect(formatTemporalPeriodKeyForDisplay("2023-H1")).toBe("H1 2023");
    expect(formatTemporalPeriodKeyForDisplay("2023-01")).toBe("Jan 2023");
    expect(formatTemporalPeriodKeyForDisplay("2023-12")).toBe("Dec 2023");
    expect(formatTemporalPeriodKeyForDisplay("2023-W12")).toBe("W12 2023");
    expect(formatTemporalPeriodKeyForDisplay("2023-03-15")).toBe("15 Mar 2023");
  });
  it("passes relative / categorical values through verbatim", () => {
    expect(formatTemporalPeriodKeyForDisplay("L12M")).toBe("L12M");
    expect(formatTemporalPeriodKeyForDisplay("YTD-TY")).toBe("YTD-TY");
    expect(formatTemporalPeriodKeyForDisplay("MARICO")).toBe("MARICO");
  });
});

describe("isCanonicalPeriodKey", () => {
  it("matches canonical shapes only", () => {
    for (const k of ["2023", "2023-Q1", "2023-H1", "2023-01", "2023-W12", "2023-03-15"]) {
      expect(isCanonicalPeriodKey(k)).toBe(true);
    }
    for (const k of ["L12M", "YTD-TY", "Q1 2023", "MARICO", "12.5"]) {
      expect(isCanonicalPeriodKey(k)).toBe(false);
    }
  });
});

describe("quarter keys sort chronologically (the bug)", () => {
  it("orders shuffled quarter keys by time, not quarter-of-year", () => {
    const x = "Quarter · Period";
    const rows = [
      { [x]: "2024-Q2", v: 1 },
      { [x]: "2023-Q1", v: 2 },
      { [x]: "2025-Q4", v: 3 },
      { [x]: "2023-Q4", v: 4 },
      { [x]: "2024-Q1", v: 5 },
    ];
    const sorted = sortRowsForLineAreaChart("line", rows, x);
    expect(sorted.map((r) => r[x])).toEqual([
      "2023-Q1",
      "2023-Q4",
      "2024-Q1",
      "2024-Q2",
      "2025-Q4",
    ]);
  });
});

describe("formatChartValue period-key handling", () => {
  it("formats canonical period keys, leaves numbers/categories alone", () => {
    expect(formatChartValue("2023-Q1", "Quarter · Period")).toBe("Q1 2023");
    expect(formatChartValue("2023-01", "Month · Period")).toBe("Jan 2023");
    // a numeric measure is not a period key — must go through numeric formatting,
    // never the period-label path.
    const numeric = formatChartValue(2023, "Sales");
    expect(numeric).not.toMatch(/^[QHW]\d/);
    expect(formatChartValue(1234.5, "Sales")).not.toBe("");
  });
});
