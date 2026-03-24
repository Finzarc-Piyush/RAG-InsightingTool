import { describe, it, expect } from "vitest";
import { sanitizeDateStringForParse } from "../lib/dateUtils.js";
import {
  inferTemporalGrainFromDates,
  formatDateForChartAxis,
} from "../lib/temporalGrain.js";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

describe("sanitizeDateStringForParse", () => {
  it("trims whitespace only (no regex date cleanup)", () => {
    expect(sanitizeDateStringForParse("  2015-01-13  ")).toBe("2015-01-13");
  });
});

describe("inferTemporalGrainFromDates", () => {
  it("classifies daily-ish series as dayOrWeek", () => {
    const dates = [
      new Date(2020, 0, 1),
      new Date(2020, 0, 2),
      new Date(2020, 0, 3),
    ];
    expect(inferTemporalGrainFromDates(dates)).toBe("dayOrWeek");
  });

  it("classifies monthly spacing as monthOrQuarter", () => {
    const dates = [
      new Date(2020, 0, 1),
      new Date(2020, 1, 1),
      new Date(2020, 2, 1),
    ];
    expect(inferTemporalGrainFromDates(dates)).toBe("monthOrQuarter");
  });

  it("classifies yearly spacing as year", () => {
    const dates = [new Date(2018, 5, 1), new Date(2019, 5, 1), new Date(2020, 5, 1)];
    expect(inferTemporalGrainFromDates(dates)).toBe("year");
  });
});

describe("formatDateForChartAxis", () => {
  it("formats dayOrWeek as dd/MM/yy", () => {
    const d = new Date(2015, 0, 13);
    expect(formatDateForChartAxis(d, "dayOrWeek")).toBe("13/01/15");
  });

  it("formats monthOrQuarter as MMM-yy", () => {
    const d = new Date(2025, 0, 1);
    expect(formatDateForChartAxis(d, "monthOrQuarter")).toBe("Jan-25");
  });

  it("formats year as yyyy", () => {
    expect(formatDateForChartAxis(new Date(2024, 6, 1), "year")).toBe("2024");
  });
});

describe("processChartData temporal x labels", () => {
  it("formats line chart x when column is in profile dateColumns and values are Date", () => {
    const chartSpec: ChartSpec = {
      type: "line",
      title: "Sales",
      x: "Order Date",
      y: "Sales",
      aggregate: "none",
    };
    const data = [
      { "Order Date": new Date(2015, 0, 13), Sales: 10 },
      { "Order Date": new Date(2015, 0, 14), Sales: 20 },
    ];
    const out = processChartData(data, chartSpec, ["Order Date"]);
    expect(out).toHaveLength(2);
    expect(out[0]!["Order Date"]).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
  });
});
