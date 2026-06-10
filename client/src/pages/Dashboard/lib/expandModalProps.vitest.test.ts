import { describe, expect, it } from "vitest";
import { buildExpandModalProps } from "./expandModalProps";
import type { ChartSpec } from "@/shared/schema";
import type { ActiveChartFilters } from "@/lib/chartFilters";

const chart = { type: "bar", title: "Chart", x: "Cluster Name", y: "pjp_adherence_rate" } as ChartSpec;
const rows = [{ "Cluster Name": "Cluster 1 NORTH", pjp_adherence_rate: 0.26 }];

describe("Wave Z2 · buildExpandModalProps", () => {
  it("passes the chart and filtered rows straight through", () => {
    const props = buildExpandModalProps(chart, {}, rows);
    expect(props.chart).toBe(chart);
    expect(props.chartData).toBe(rows);
  });

  it("reports filtersApplied=false for empty / undefined filters", () => {
    expect(buildExpandModalProps(chart, {}, rows).filtersApplied).toBe(false);
    expect(buildExpandModalProps(chart, undefined, rows).filtersApplied).toBe(false);
    // A cleared key (value undefined) does not count as applied.
    expect(
      buildExpandModalProps(chart, { "Cluster Name": undefined }, rows).filtersApplied,
    ).toBe(false);
  });

  it("reports filtersApplied=true when an active selection exists", () => {
    const filters: ActiveChartFilters = {
      "Cluster Name": { type: "categorical", values: ["Cluster 2 WEST"] },
    };
    const props = buildExpandModalProps(chart, filters, rows);
    expect(props.filtersApplied).toBe(true);
    expect(props.effectiveFilters).toBe(filters);
  });

  it("defaults effectiveFilters to an empty object when filters is undefined", () => {
    expect(buildExpandModalProps(chart, undefined, rows).effectiveFilters).toEqual({});
  });
});
