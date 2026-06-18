// Wave S4 · useChartSort — instant client-side re-ordering of a chart spec.
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useChartSort, chartSupportsSort } from "./useChartSort";
import type { ChartSpec } from "@/shared/schema";

afterEach(() => cleanup());

const baseSpec = (): ChartSpec => ({
  type: "bar",
  title: "Survived by age",
  x: "Age",
  y: "Survived",
  data: [
    { Age: "25", Survived: 30 },
    { Age: "5", Survived: 50 },
    { Age: "10", Survived: 10 },
  ],
});

const ages = (spec: ChartSpec) => (spec.data ?? []).map((r) => r.Age);

describe("useChartSort", () => {
  it("returns the spec untouched when no sort is active", () => {
    const spec = baseSpec();
    const { result } = renderHook(() => useChartSort(spec));
    expect(ages(result.current.sortedSpec)).toEqual(["25", "5", "10"]);
  });

  it("seeds from spec.sort and orders the data accordingly", () => {
    const spec = { ...baseSpec(), sort: { by: "category", direction: "asc" } as const };
    const { result } = renderHook(() => useChartSort(spec));
    expect(ages(result.current.sortedSpec)).toEqual(["5", "10", "25"]);
  });

  it("re-orders instantly when setSort is called (no round-trip)", () => {
    const spec = baseSpec();
    const { result } = renderHook(() => useChartSort(spec));

    act(() => result.current.setSort({ by: "category", direction: "asc" }));
    expect(ages(result.current.sortedSpec)).toEqual(["5", "10", "25"]);

    act(() => result.current.setSort({ by: "value", direction: "desc" }));
    expect(result.current.sortedSpec.data?.map((r) => r.Survived)).toEqual([50, 30, 10]);

    // the active sort is mirrored onto the returned spec for persistence
    expect(result.current.sortedSpec.sort).toEqual({ by: "value", direction: "desc" });
  });

  it("re-seeds the override when the underlying chart changes", () => {
    const first = baseSpec();
    const { result, rerender } = renderHook((s: ChartSpec) => useChartSort(s), {
      initialProps: first,
    });
    act(() => result.current.setSort({ by: "category", direction: "asc" }));
    expect(ages(result.current.sortedSpec)).toEqual(["5", "10", "25"]);

    // a structurally different chart resets the user override
    const second: ChartSpec = {
      ...baseSpec(),
      title: "A different chart",
      data: [
        { Age: "9", Survived: 1 },
        { Age: "2", Survived: 9 },
      ],
    };
    rerender(second);
    // no override, no baked sort → data passes through in its given order
    expect(ages(result.current.sortedSpec)).toEqual(["9", "2"]);
  });
});

describe("chartSupportsSort", () => {
  it("true for a bar chart with multiple rows", () => {
    expect(chartSupportsSort({ type: "bar", data: [{}, {}] })).toBe(true);
  });
  it("false for a line chart", () => {
    expect(chartSupportsSort({ type: "line", data: [{}, {}] })).toBe(false);
  });
  it("false for a single-row bar", () => {
    expect(chartSupportsSort({ type: "bar", data: [{}] })).toBe(false);
  });
});
