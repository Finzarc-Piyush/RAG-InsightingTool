import { describe, expect, it } from "vitest";
import {
  inferFormatHint,
  formatKMB,
  formatCurrency,
  formatPercent,
  formatDateSmart,
  formatChartValue,
} from "./format";

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

  it("falls back to kmb for generic numeric columns", () => {
    expect(inferFormatHint("Volume")).toBe("kmb");
    expect(inferFormatHint("count")).toBe("kmb");
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

  it("formats thousands with K suffix", () => {
    expect(formatKMB(1000)).toBe("1K");
    expect(formatKMB(1234)).toBe("1.2K");
    expect(formatKMB(50_000)).toBe("50K");
    expect(formatKMB(999_999)).toBe("1000K"); // boundary
  });

  it("formats millions / billions / trillions", () => {
    expect(formatKMB(1_000_000)).toBe("1M");
    expect(formatKMB(1_500_000)).toBe("1.5M");
    expect(formatKMB(2_000_000_000)).toBe("2B");
    expect(formatKMB(3_500_000_000_000)).toBe("3.5T");
  });

  it("preserves negative sign", () => {
    expect(formatKMB(-1234)).toBe("-1.2K");
    expect(formatKMB(-1_000_000)).toBe("-1M");
  });

  it("returns em-dash for non-finite", () => {
    expect(formatKMB(NaN)).toBe("—");
    expect(formatKMB(Infinity)).toBe("—");
  });
});

describe("format · formatCurrency", () => {
  it("prepends symbol and formats magnitude", () => {
    expect(formatCurrency(1234)).toBe("$1.2K");
    expect(formatCurrency(1_500_000, "₹")).toBe("₹1.5M");
  });

  it("handles negatives with sign before symbol", () => {
    expect(formatCurrency(-1234)).toBe("-$1.2K");
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
  it("uses field-name inference by default", () => {
    expect(formatChartValue(1234, "Revenue")).toBe("$1.2K");
    expect(formatChartValue(0.42, "ConversionRate")).toBe("42.0%");
    expect(formatChartValue(1234, "Volume")).toBe("1.2K");
  });

  it("respects explicit format override", () => {
    expect(formatChartValue(1234, "Revenue", { format: "kmb" })).toBe("1.2K");
    expect(formatChartValue(0.42, "Volume", { format: "percent" })).toBe("42.0%");
  });

  it("returns em-dash for null/undefined/empty", () => {
    expect(formatChartValue(null, "X")).toBe("—");
    expect(formatChartValue(undefined, "X")).toBe("—");
    expect(formatChartValue("", "X")).toBe("—");
  });

  it("custom precision", () => {
    expect(formatChartValue(1234, "Revenue", { precision: 2 })).toBe("$1.23K");
  });
});
