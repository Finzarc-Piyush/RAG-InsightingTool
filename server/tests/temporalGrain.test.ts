import { describe, it, expect } from "vitest";
import { sanitizeDateStringForParse, parseFlexibleDate } from "../lib/dateUtils.js";
import {
  inferTemporalGrainFromDates,
  formatDateForChartAxis,
} from "../lib/temporalGrain.js";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

describe("sanitizeDateStringForParse", () => {
  it("strips trailing India Standard Time parenthetical", () => {
    const raw = "13/01/2015 (India Standard Time)";
    expect(sanitizeDateStringForParse(raw)).toBe("13/01/2015");
    const d = parseFlexibleDate(raw);
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2015);
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
  it("formats line chart Order Date axis strings after sort", () => {
    const chartSpec: ChartSpec = {
      type: "line",
      title: "Sales",
      x: "Order Date",
      y: "Sales",
      aggregate: "none",
    };
    const data = [
      { "Order Date": "2015-01-13", Sales: 10 },
      { "Order Date": "2015-01-14", Sales: 20 },
    ];
    const out = processChartData(data, chartSpec);
    expect(out).toHaveLength(2);
    expect(out[0]!["Order Date"]).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
  });
});
