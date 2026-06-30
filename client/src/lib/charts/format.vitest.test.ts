import { describe, expect, it } from "vitest";
import {
  inferFormatHint,
  isDateFieldName,
  formatKMB,
  formatCurrency,
  formatPercent,
  formatDateSmart,
  formatChartValue,
  makeAxisTickFormatter,
} from "./format";

describe("format · isDateFieldName (shared date-by-name test)", () => {
  it("recognises calendar columns", () => {
    expect(isDateFieldName("Date")).toBe(true);
    expect(isDateFieldName("Order Date")).toBe(true);
    expect(isDateFieldName("created_at")).toBe(true);
    expect(isDateFieldName("updated_on")).toBe(true);
    expect(isDateFieldName("Order Month")).toBe(true);
    expect(isDateFieldName("Fiscal Quarter")).toBe(true);
  });
  it("excludes the standalone 'Day' ordinal and empty input", () => {
    expect(isDateFieldName("Day")).toBe(false);
    expect(isDateFieldName("Auto- Day")).toBe(false);
    expect(isDateFieldName(undefined)).toBe(false);
    expect(isDateFieldName("")).toBe(false);
  });
});

describe("format · inferFormatHint", () => {
  it("detects currency by column name", () => {
    expect(inferFormatHint("Revenue")).toBe("currency");
    expect(inferFormatHint("revenue_usd")).toBe("currency");
    expect(inferFormatHint("Total Cost")).toBe("currency");
    expect(inferFormatHint("Price (INR)")).toBe("currency");
  });

  it("detects percent by column name", () => {
    expect(inferFormatHint("conversion_rate")).toBe("percent");
    expect(inferFormatHint("Growth %")).toBe("percent");
    expect(inferFormatHint("Market Share")).toBe("percent");
  });

  it("detects date by column name", () => {
    expect(inferFormatHint("Date")).toBe("date");
    expect(inferFormatHint("Order Month")).toBe("date");
    expect(inferFormatHint("created_at")).toBe("date");
  });

  it("detects duration by column name (DUR1)", () => {
    expect(inferFormatHint("Working Hrs")).toBe("duration");
    expect(inferFormatHint("Total Hours")).toBe("duration");
    expect(inferFormatHint("TAT")).toBe("duration");
  });

  it("falls back to kmb for generic numeric columns", () => {
    expect(inferFormatHint("Volume")).toBe("kmb");
    expect(inferFormatHint("count")).toBe("kmb");
  });

  it("treats an ordinal 'Day' counter as numeric, NOT a date (no 1-Jan-1970 axis)", () => {
    // Regression: "Day" (an ordinal 1..N) was inferred as a date, so a value
    // like avg(Day)=15 rendered as `new Date(15)` → "1 Jan 1970".
    expect(inferFormatHint("Day")).toBe("kmb");
    expect(inferFormatHint("Auto- Day")).toBe("kmb");
    // The real calendar column is still a date.
    expect(inferFormatHint("Date")).toBe("date");
    expect(inferFormatHint("TSOE-Date Combo")).toBe("date");
    // And the metric axis formats as a plain number, never an epoch date.
    expect(formatChartValue(15, "Day")).toBe("15");
    expect(formatChartValue(0, "Day")).toBe("0");
  });

  it("returns 'raw' for missing field name", () => {
    expect(inferFormatHint(undefined)).toBe("raw");
    expect(inferFormatHint("")).toBe("raw");
  });
});

describe("format · formatKMB", () => {
  it("keeps small numbers as-is", () => {
    expect(formatKMB(0)).toBe("0");
    expect(formatKMB(42)).toBe("42");
    expect(formatKMB(999)).toBe("999");
  });

  it("formats thousands with a spaced K suffix", () => {
    expect(formatKMB(1000)).toBe("1 K");
    expect(formatKMB(1234)).toBe("1.23 K");
    expect(formatKMB(50_000)).toBe("50 K");
    expect(formatKMB(999_999)).toBe("10 Lac"); // boundary rounds up into the lakh tier
  });

  it("formats lakhs / crores (Indian system)", () => {
    expect(formatKMB(1_000_000)).toBe("10 Lac");
    expect(formatKMB(1_500_000)).toBe("15 Lac");
    expect(formatKMB(481_000)).toBe("4.81 Lac");
    expect(formatKMB(2_000_000_000)).toBe("200 Cr");
    expect(formatKMB(1_049_389_992.94)).toBe("104.9 Cr");
  });

  it("preserves negative sign", () => {
    expect(formatKMB(-1234)).toBe("-1.23 K");
    expect(formatKMB(-1_000_000)).toBe("-10 Lac");
  });

  it("returns em-dash for non-finite", () => {
    expect(formatKMB(NaN)).toBe("—");
    expect(formatKMB(Infinity)).toBe("—");
  });
});

describe("format · formatCurrency", () => {
  it("prepends ₹ by default (data is INR) and Indian-formats the magnitude", () => {
    expect(formatCurrency(1234)).toBe("₹1.23 K");
    expect(formatCurrency(1_500_000, "₹")).toBe("₹15 Lac");
    expect(formatCurrency(311_587_406.72)).toBe("₹31.2 Cr");
  });

  it("handles negatives with sign before symbol", () => {
    expect(formatCurrency(-1234)).toBe("-₹1.23 K");
  });
});

describe("format · formatPercent", () => {
  it("multiplies fractional values by 100", () => {
    expect(formatPercent(0.123)).toBe("12.3%");
    expect(formatPercent(0.5)).toBe("50.0%");
  });

  it("treats already-percent values (>1, ≤100) as-is", () => {
    expect(formatPercent(12.3)).toBe("12.3%");
    expect(formatPercent(50)).toBe("50.0%");
  });

  it("returns em-dash for NaN", () => {
    expect(formatPercent(NaN)).toBe("—");
  });
});

describe("format · formatDateSmart", () => {
  it("formats with full date when no range hint", () => {
    expect(formatDateSmart("2024-03-15")).toMatch(/15 Mar 2024/);
  });

  it("uses month + year for medium ranges", () => {
    const range = 365 * 24 * 60 * 60 * 1000;
    expect(formatDateSmart("2024-03-15", range)).toMatch(/Mar/);
  });

  it("returns input for unparseable dates", () => {
    expect(formatDateSmart("not-a-date")).toBe("not-a-date");
  });
});

describe("format · formatChartValue (universal)", () => {
  it("uses field-name inference by default (₹ on currency fields)", () => {
    expect(formatChartValue(1234, "Revenue")).toBe("₹1.23 K");
    expect(formatChartValue(0.42, "ConversionRate")).toBe("42.0%");
    expect(formatChartValue(1234, "Volume")).toBe("1.23 K");
    // The screenshot bug: an unmapped currency field (retailer margin) used to
    // render "$10.5M"; it must now read ₹ + Cr/Lac.
    expect(formatChartValue(10_500_000, "Retailer Margin")).toBe("₹1.05 Cr");
  });

  it("respects explicit format override", () => {
    expect(formatChartValue(1234, "Revenue", { format: "kmb" })).toBe("1.23 K");
    expect(formatChartValue(0.42, "Volume", { format: "percent" })).toBe("42.0%");
  });

  it("returns em-dash for null/undefined/empty", () => {
    expect(formatChartValue(null, "X")).toBe("—");
    expect(formatChartValue(undefined, "X")).toBe("—");
    expect(formatChartValue("", "X")).toBe("—");
  });

  it("magnitude decimals are adaptive (1 dp ≥10 scaled, 2 dp below)", () => {
    expect(formatChartValue(1234, "Revenue", { precision: 2 })).toBe("₹1.23 K");
  });

  it("magnitude guard: ordinal values on a date-NAMED axis render as plain numbers, not 1-Jan-1970", () => {
    // "Week"/"Month"/"Year" still match the date-name heuristic, but a small
    // numeric value is an ordinal — formatting it as a date gave "1 Jan 1970".
    expect(formatChartValue(12, "Week")).toBe("12"); // week 12
    expect(formatChartValue(3, "Month")).toBe("3"); // month 3
    expect(formatChartValue(2025, "Year")).toBe("2025"); // year, not "1 Jan 1970"
    // A real epoch-millis date value still formats as a date.
    const realMs = Date.UTC(2024, 2, 15); // 2024-03-15, ~1.71e12
    expect(formatChartValue(realMs, "Date")).toMatch(/2024/);
    // ISO date strings still format as dates.
    expect(formatChartValue("2024-03-15", "Date")).toMatch(/2024/);
  });
});

describe("Wave F1 · makeAxisTickFormatter (field-aware axis ticks)", () => {
  it("renders rate columns as percentages (the dashboard axis fix)", () => {
    const fmt = makeAxisTickFormatter("pjp_adherence_rate");
    // The screenshot bug: 0.28 axis tick should read "28%", not "0.28".
    expect(fmt(0.28)).toBe("28.0%");
    expect(fmt(0.04)).toBe("4.0%");
  });

  it("renders currency columns with ₹ + Cr/Lac/K", () => {
    expect(makeAxisTickFormatter("Revenue")(1234)).toBe("₹1.23 K");
  });

  it("renders plain numeric measures with Cr/Lac/K", () => {
    expect(makeAxisTickFormatter("Units Sold")(1500)).toBe("1.5 K");
  });

  it("renders duration columns as durations (DUR1)", () => {
    // "Working Hrs" is a decimal-hours measure → axis tick reads as a duration.
    expect(makeAxisTickFormatter("Working Hrs")(3.5325)).toBe("3h 32m");
  });

  it("ignores the recharts tick index argument", () => {
    const fmt = makeAxisTickFormatter("share") as (v: unknown, i?: number) => string;
    expect(fmt(0.5, 3)).toBe("50.0%");
  });
});
