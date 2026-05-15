import { describe, expect, it } from "vitest";
import {
  capturedActiveFilterToChartFilters,
  dashboardFilterableColumns,
  extractTileColumns,
  globalForTile,
} from "./dashboardGlobalFilters";
import type { DashboardTile } from "./types";
import type { ActiveFilterSpec } from "@/shared/schema";

/**
 * DR4 · pure-helper coverage for the global filter machinery.
 *
 * Pins:
 *  - chart tiles surface their column union; non-chart kinds return [].
 *  - captured-filter shapes (in / range / dateRange) translate to the
 *    matching ChartRenderer selection type, with degenerate inputs
 *    silently dropped (no half-built selections).
 *  - perTile beats global; when no perTile, the global splits into
 *    applicable + inapplicable per tile column membership.
 *  - column frequency scoring sorts by `appearsInTiles` desc and uses
 *    the column name as a tiebreak.
 */

function chartTile(id: string, rows: Record<string, unknown>[]): DashboardTile {
  return {
    kind: "chart",
    id,
    title: id,
    index: 0,
    chart: {
      type: "bar",
      title: id,
      x: "x",
      y: "y",
      data: rows,
    } as unknown as DashboardTile extends { kind: "chart" }
      ? DashboardTile["chart"]
      : never,
  } as DashboardTile;
}

function narrativeTile(id: string): DashboardTile {
  return {
    kind: "narrative",
    id,
    title: id,
    block: { id, role: "custom", title: id, body: "...", order: 0 },
  } as DashboardTile;
}

describe("extractTileColumns", () => {
  it("returns the union of keys across chart data rows", () => {
    const tile = chartTile("c1", [
      { Region: "North", Sales: 1 },
      { Region: "South", Brand: "A" },
    ]);
    expect(new Set(extractTileColumns(tile))).toEqual(
      new Set(["Region", "Sales", "Brand"]),
    );
  });

  it("returns [] for non-chart tile kinds", () => {
    expect(extractTileColumns(narrativeTile("n1"))).toEqual([]);
  });

  it("returns [] when chart has no data", () => {
    const tile = chartTile("c1", []);
    expect(extractTileColumns(tile)).toEqual([]);
  });
});

describe("capturedActiveFilterToChartFilters", () => {
  it("translates 'in' conditions into categorical selections", () => {
    const spec: ActiveFilterSpec = {
      version: 1,
      updatedAt: 0,
      conditions: [{ kind: "in", column: "Region", values: ["North"] }],
    };
    expect(capturedActiveFilterToChartFilters(spec)).toEqual({
      Region: { type: "categorical", values: ["North"] },
    });
  });

  it("translates 'range' conditions into numeric selections", () => {
    const spec: ActiveFilterSpec = {
      version: 1,
      updatedAt: 0,
      conditions: [{ kind: "range", column: "Sales", min: 100, max: 500 }],
    };
    expect(capturedActiveFilterToChartFilters(spec)).toEqual({
      Sales: { type: "numeric", min: 100, max: 500 },
    });
  });

  it("translates 'dateRange' conditions into date selections", () => {
    const spec: ActiveFilterSpec = {
      version: 1,
      updatedAt: 0,
      conditions: [
        { kind: "dateRange", column: "Date", from: "2024-01-01", to: "2024-12-31" },
      ],
    };
    expect(capturedActiveFilterToChartFilters(spec)).toEqual({
      Date: { type: "date", start: "2024-01-01", end: "2024-12-31" },
    });
  });

  it("drops degenerate conditions (empty values, null bounds)", () => {
    const spec: ActiveFilterSpec = {
      version: 1,
      updatedAt: 0,
      conditions: [
        { kind: "in", column: "X", values: [] },
        { kind: "range", column: "Y" },
        { kind: "dateRange", column: "Z" },
      ],
    };
    expect(capturedActiveFilterToChartFilters(spec)).toEqual({});
  });

  it("returns {} when spec is undefined", () => {
    expect(capturedActiveFilterToChartFilters(undefined)).toEqual({});
  });
});

describe("globalForTile", () => {
  const tile = chartTile("c1", [
    { Region: "North", Sales: 1 },
    { Region: "South", Sales: 2 },
  ]);

  it("partitions global into applicable + inapplicable based on tile columns", () => {
    const out = globalForTile(
      tile,
      {
        Region: { type: "categorical", values: ["North"] },
        Brand: { type: "categorical", values: ["A"] },
      },
      undefined,
    );
    expect(out.applicable).toEqual({
      Region: { type: "categorical", values: ["North"] },
    });
    expect(out.inapplicableColumns).toEqual(["Brand"]);
  });

  it("ignores undefined selections inside the global record", () => {
    const out = globalForTile(
      tile,
      { Region: undefined, Sales: { type: "numeric", min: 0 } },
      undefined,
    );
    expect(out.applicable).toEqual({ Sales: { type: "numeric", min: 0 } });
    expect(out.inapplicableColumns).toEqual([]);
  });

  it("perTile override wins outright and clears inapplicable", () => {
    const out = globalForTile(
      tile,
      {
        Region: { type: "categorical", values: ["North"] },
        Brand: { type: "categorical", values: ["A"] },
      },
      { Region: { type: "categorical", values: ["South"] } },
    );
    expect(out.applicable).toEqual({
      Region: { type: "categorical", values: ["South"] },
    });
    expect(out.inapplicableColumns).toEqual([]);
  });

  it("non-chart tile receives empty applicable + every global column listed inapplicable", () => {
    const n = narrativeTile("n1");
    const out = globalForTile(
      n,
      { Region: { type: "categorical", values: ["North"] } },
      undefined,
    );
    expect(out.applicable).toEqual({});
    expect(out.inapplicableColumns).toEqual(["Region"]);
  });
});

describe("dashboardFilterableColumns", () => {
  it("counts column appearance only across chart tiles, sorts by frequency", () => {
    const tiles: DashboardTile[] = [
      chartTile("c1", [{ Region: "N", Sales: 1, Brand: "A" }]),
      chartTile("c2", [{ Region: "N", Sales: 2 }]),
      chartTile("c3", [{ Brand: "A" }]),
      narrativeTile("n1"),
    ];
    const cols = dashboardFilterableColumns(tiles);
    // Tiebreak is alphabetical when frequency ties.
    expect(cols).toEqual([
      { column: "Brand", appearsInTiles: 2, totalChartTiles: 3 },
      { column: "Region", appearsInTiles: 2, totalChartTiles: 3 },
      { column: "Sales", appearsInTiles: 2, totalChartTiles: 3 },
    ]);
  });

  it("returns [] when there are no chart tiles", () => {
    expect(dashboardFilterableColumns([narrativeTile("n1")])).toEqual([]);
  });
});
