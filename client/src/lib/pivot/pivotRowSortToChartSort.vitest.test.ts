// Wave S7 · pivot rowSort → chart sort mapping.
import { describe, it, expect } from "vitest";
import { pivotRowSortToChartSort } from "./pivotRowSortToChartSort";

describe("pivotRowSortToChartSort", () => {
  it("returns undefined when the pivot has no row sort", () => {
    expect(pivotRowSortToChartSort(undefined)).toBeUndefined();
  });

  it("maps a rowLabel sort to a category-axis sort", () => {
    expect(pivotRowSortToChartSort({ primary: "rowLabel", direction: "asc" })).toEqual({
      by: "category",
      direction: "asc",
    });
  });

  it("maps a measure sort to a value sort", () => {
    expect(
      pivotRowSortToChartSort({ primary: "measure", byValueSpecId: "v1", direction: "desc" }),
    ).toEqual({ by: "value", direction: "desc" });
  });

  it("defaults to value when primary is omitted (measure sort)", () => {
    expect(pivotRowSortToChartSort({ direction: "asc" })).toEqual({
      by: "value",
      direction: "asc",
    });
  });
});
