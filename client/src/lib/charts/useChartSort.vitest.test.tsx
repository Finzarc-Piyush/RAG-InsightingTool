// Wave S4 · useChartSort — instant client-side re-ordering of a chart spec.
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useChartSort, chartSupportsSort } from "./useChartSort";
import type { ChartSpec, ChartSpecV2 } from "@/shared/schema";

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

// Wave B1 · v2 (Chart v1→v2 convergence) sort support.
const v2BarSpec = (): ChartSpecV2 =>
  ({
    version: 2,
    mark: "bar",
    encoding: {
      x: { field: "Sex", type: "n" },
      y: { field: "Survived", type: "q" },
    },
    source: {
      kind: "inline",
      rows: [
        { Sex: "female", Survived: 30 },
        { Sex: "male", Survived: 50 },
        { Sex: "other", Survived: 10 },
      ],
    },
  }) as unknown as ChartSpecV2;

const sexOrder = (spec: ChartSpecV2) =>
  spec.source.kind === "inline"
    ? spec.source.rows.map((r) => r.Sex)
    : [];

describe("useChartSort · v2 specs", () => {
  it("chartSupportsSort true for a v2 bar with >1 inline rows", () => {
    expect(chartSupportsSort(v2BarSpec())).toBe(true);
  });
  it("chartSupportsSort false for a v2 line mark", () => {
    const line = { ...v2BarSpec(), mark: "line" } as ChartSpecV2;
    expect(chartSupportsSort(line)).toBe(false);
  });
  it("chartSupportsSort false for a v2 bar with a non-inline (session-ref) source", () => {
    const ref = {
      ...v2BarSpec(),
      source: { kind: "session-ref", sessionId: "s1" },
    } as unknown as ChartSpecV2;
    expect(chartSupportsSort(ref)).toBe(false);
  });

  it("starts in the server's source order (no baked interactive sort)", () => {
    const { result } = renderHook(() => useChartSort(v2BarSpec()));
    expect(sexOrder(result.current.sortedSpec)).toEqual([
      "female",
      "male",
      "other",
    ]);
  });

  it("re-orders the v2 source rows by value (desc)", () => {
    const { result } = renderHook(() => useChartSort(v2BarSpec()));
    act(() => result.current.setSort({ by: "value", direction: "desc" }));
    expect(sexOrder(result.current.sortedSpec)).toEqual([
      "male", // 50
      "female", // 30
      "other", // 10
    ]);
  });

  it("re-orders the v2 source rows by category (asc)", () => {
    const { result } = renderHook(() => useChartSort(v2BarSpec()));
    act(() => result.current.setSort({ by: "category", direction: "asc" }));
    expect(sexOrder(result.current.sortedSpec)).toEqual([
      "female",
      "male",
      "other",
    ]);
  });

  it("never re-orders a v2 line mark even if a sort is set", () => {
    const line = { ...v2BarSpec(), mark: "line" } as ChartSpecV2;
    const { result } = renderHook(() => useChartSort(line));
    act(() => result.current.setSort({ by: "value", direction: "desc" }));
    expect(sexOrder(result.current.sortedSpec)).toEqual([
      "female",
      "male",
      "other",
    ]);
  });
});
