import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sanitizeDateStringForParse } from "../lib/dateUtils.js";
import {
  inferTemporalGrainFromDates,
  formatDateForChartAxis,
} from "../lib/temporalGrain.js";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

describe("sanitizeDateStringForParse", () => {
  it("trims whitespace only (no regex date cleanup)", () => {
    assert.equal(sanitizeDateStringForParse("  2015-01-13  "), "2015-01-13");
  });
});

describe("inferTemporalGrainFromDates", () => {
  it("classifies daily-ish series as dayOrWeek", () => {
    const dates = [
      new Date(2020, 0, 1),
      new Date(2020, 0, 2),
      new Date(2020, 0, 3),
    ];
    assert.equal(inferTemporalGrainFromDates(dates), "dayOrWeek");
  });

  it("classifies monthly spacing as monthOrQuarter", () => {
    const dates = [
      new Date(2020, 0, 1),
      new Date(2020, 1, 1),
      new Date(2020, 2, 1),
    ];
    assert.equal(inferTemporalGrainFromDates(dates), "monthOrQuarter");
  });

  it("classifies yearly spacing as year", () => {
    const dates = [new Date(2018, 5, 1), new Date(2019, 5, 1), new Date(2020, 5, 1)];
    assert.equal(inferTemporalGrainFromDates(dates), "year");
  });
});

describe("formatDateForChartAxis", () => {
  it("formats dayOrWeek as dd/MM/yy", () => {
    const d = new Date(2015, 0, 13);
    assert.equal(formatDateForChartAxis(d, "dayOrWeek"), "13/01/15");
  });

  it("formats monthOrQuarter as MMM-yy", () => {
    const d = new Date(2025, 0, 1);
    assert.equal(formatDateForChartAxis(d, "monthOrQuarter"), "Jan-25");
  });

  it("formats year as yyyy", () => {
    assert.equal(formatDateForChartAxis(new Date(2024, 6, 1), "year"), "2024");
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
    assert.equal(out.length, 2);
    assert.match(String(out[0]!["Order Date"]), /^\d{2}\/\d{2}\/\d{2}$/);
  });
});
