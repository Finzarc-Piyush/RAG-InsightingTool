import { describe, expect, it } from "vitest";
import {
  addCategoricalFilter,
  addDateFilter,
  addNumericFilter,
  aggregateTileRowsForFiltering,
  availableFilterDefinitions,
} from "./dashboardGlobalFilters";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import type { DashboardTile } from "./types";

/**
 * Wave WD1 · pure-helper tests for the dashboard global filter bar's
 * `+ Add filter` flow. The popover component itself (`AddFilterPopover`)
 * is exercised by manual smoke; this file pins the contract for the
 * data-shape helpers it consumes.
 */

function chartTile(
  id: string,
  data: Record<string, unknown>[],
): DashboardTile {
  return {
    kind: "chart",
    id,
    title: id,
    index: 0,
    chart: {
      // ChartSpec is loose at the type-system level; only chart.data is
      // load-bearing for these helpers.
      data,
    } as unknown as DashboardTile extends { kind: "chart" } ? DashboardTile["chart"] : never,
  } as unknown as DashboardTile;
}

function narrativeTile(id: string): DashboardTile {
  return {
    kind: "narrative",
    id,
    title: id,
    index: 0,
    body: "",
  } as unknown as DashboardTile;
}

describe("WD1 · aggregateTileRowsForFiltering", () => {
  it("concatenates rows across chart tiles in tile order", () => {
    const tiles = [
      chartTile("a", [{ region: "N", sales: 10 }]),
      chartTile("b", [
        { region: "S", sales: 20 },
        { region: "E", sales: 30 },
      ]),
    ];
    const rows = aggregateTileRowsForFiltering(tiles);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ region: "N", sales: 10 });
    expect(rows[2]).toEqual({ region: "E", sales: 30 });
  });

  it("skips non-chart tiles cleanly", () => {
    const tiles = [
      narrativeTile("intro"),
      chartTile("chart1", [{ region: "N" }]),
      narrativeTile("outro"),
    ];
    const rows = aggregateTileRowsForFiltering(tiles);
    expect(rows).toEqual([{ region: "N" }]);
  });

  it("respects maxRowsPerTile to keep filter-definition work bounded", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ idx: i }));
    const tiles = [chartTile("a", big)];
    const rows = aggregateTileRowsForFiltering(tiles, 100);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ idx: 0 });
    expect(rows[99]).toEqual({ idx: 99 });
  });

  it("returns [] for an empty dashboard", () => {
    expect(aggregateTileRowsForFiltering([])).toEqual([]);
  });

  it("skips chart tiles with empty data arrays", () => {
    const tiles = [chartTile("empty", []), chartTile("nonempty", [{ x: 1 }])];
    const rows = aggregateTileRowsForFiltering(tiles);
    expect(rows).toEqual([{ x: 1 }]);
  });
});

describe("WD1 · availableFilterDefinitions", () => {
  it("returns filter defs for categorical + numeric columns derived from tile data", () => {
    const tiles = [
      chartTile("a", [
        { region: "North", sales: 10 },
        { region: "South", sales: 20 },
        { region: "North", sales: 15 },
      ]),
    ];
    const defs = availableFilterDefinitions(tiles, {});
    const keys = defs.map((d) => d.key);
    expect(keys).toContain("region");
    expect(keys).toContain("sales");
    const region = defs.find((d) => d.key === "region")!;
    expect(region.type).toBe("categorical");
    if (region.type === "categorical") {
      const values = region.options.map((o) => o.value).sort();
      expect(values).toEqual(["North", "South"]);
    }
    const sales = defs.find((d) => d.key === "sales")!;
    expect(sales.type).toBe("numeric");
    if (sales.type === "numeric") {
      expect(sales.min).toBe(10);
      expect(sales.max).toBe(20);
    }
  });

  it("excludes columns already in the current global filter", () => {
    const tiles = [
      chartTile("a", [
        { region: "North", channel: "Retail" },
        { region: "South", channel: "Online" },
      ]),
    ];
    const current: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const defs = availableFilterDefinitions(tiles, current);
    const keys = defs.map((d) => d.key);
    expect(keys).not.toContain("region");
    expect(keys).toContain("channel");
  });

  it("returns [] when there are no chart tiles", () => {
    expect(availableFilterDefinitions([narrativeTile("intro")], {})).toEqual([]);
  });

  it("sorts columns by frequency across tiles, then alphabetically", () => {
    // "channel" appears in 2 tiles; "region" in 1; alphabetic for the rest.
    const tiles = [
      chartTile("a", [{ region: "N", channel: "Retail" }]),
      chartTile("b", [{ channel: "Online", brand: "MARICO" }]),
    ];
    const defs = availableFilterDefinitions(tiles, {});
    // channel (2 tiles) should be first; brand and region (1 tile each) follow alphabetically.
    expect(defs[0].key).toBe("channel");
    const tail = defs.slice(1).map((d) => d.key);
    expect(tail).toEqual(["brand", "region"]);
  });
});

describe("WD1 · pure filter-add helpers", () => {
  it("addCategoricalFilter creates a categorical selection", () => {
    const next = addCategoricalFilter({}, "region", ["North", "South"]);
    expect(next).toEqual({
      region: { type: "categorical", values: ["North", "South"] },
    });
  });

  it("addCategoricalFilter is a no-op when values is empty", () => {
    const current = { region: { type: "categorical" as const, values: ["X"] } };
    expect(addCategoricalFilter(current, "region", [])).toBe(current);
  });

  it("addCategoricalFilter does NOT mutate input", () => {
    const current: ActiveChartFilters = {
      region: { type: "categorical", values: ["X"] },
    };
    const next = addCategoricalFilter(current, "channel", ["Retail"]);
    expect(current).toEqual({
      region: { type: "categorical", values: ["X"] },
    });
    expect(next.channel).toEqual({
      type: "categorical",
      values: ["Retail"],
    });
  });

  it("addNumericFilter accepts min only, max only, or both", () => {
    expect(addNumericFilter({}, "sales", 5, 100).sales).toEqual({
      type: "numeric",
      min: 5,
      max: 100,
    });
    expect(addNumericFilter({}, "sales", 5, undefined).sales).toEqual({
      type: "numeric",
      min: 5,
    });
    expect(addNumericFilter({}, "sales", undefined, 100).sales).toEqual({
      type: "numeric",
      max: 100,
    });
  });

  it("addNumericFilter is a no-op when both bounds are undefined", () => {
    const current = { sales: { type: "numeric" as const, min: 1 } };
    expect(addNumericFilter(current, "sales", undefined, undefined)).toBe(current);
  });

  it("addDateFilter accepts start only, end only, or both", () => {
    expect(addDateFilter({}, "date", "2024-01-01", "2024-12-31").date).toEqual({
      type: "date",
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(addDateFilter({}, "date", "2024-01-01", undefined).date).toEqual({
      type: "date",
      start: "2024-01-01",
    });
  });

  it("addDateFilter is a no-op when both bounds are empty / undefined", () => {
    const current = { date: { type: "date" as const, start: "2024-01-01" } };
    expect(addDateFilter(current, "date", "", undefined)).toBe(current);
    expect(addDateFilter(current, "date", undefined, "")).toBe(current);
  });

  it("subsequent calls overwrite the same column's selection", () => {
    let state: ActiveChartFilters = {};
    state = addCategoricalFilter(state, "region", ["N"]);
    state = addCategoricalFilter(state, "region", ["S", "E"]);
    expect(state.region).toEqual({
      type: "categorical",
      values: ["S", "E"],
    });
  });
});
