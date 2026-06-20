// Wave S5 · InteractiveChartCard wires the "Sort by" control → instant re-order
// of the spec handed to renderLegacy + a persistence callback.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartSpec } from "@/shared/schema";

// Isolate the toolbar: ChartShim renders the legacy slot for v1 specs and, for
// v2 specs, exposes the (re-ordered) source-row x order so we can assert it.
vi.mock("./ChartShim", () => ({
  ChartShim: ({ spec, legacy }: { spec: any; legacy: () => unknown }) => {
    if (spec && spec.version === 2 && spec.source?.kind === "inline") {
      const xField = spec.encoding?.x?.field;
      return (
        <div data-testid="v2-order">
          {spec.source.rows.map((r: Record<string, unknown>) => r[xField]).join(",")}
        </div>
      );
    }
    return <div>{legacy() as never}</div>;
  },
}));

import { InteractiveChartCard } from "./InteractiveChartCard";

afterEach(() => cleanup());

const singleSeries = (): ChartSpec => ({
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

const multiSeries = (): ChartSpec => ({
  type: "bar",
  title: "By age + gender",
  x: "Age",
  y: "M",
  seriesColumn: "Gender",
  seriesKeys: ["M", "F"],
  data: [
    { Age: "25", M: 3, F: 1 },
    { Age: "5", M: 2, F: 2 },
    { Age: "10", M: 10, F: 10 },
  ],
});

describe("InteractiveChartCard · sort wiring", () => {
  it("re-orders the spec passed to renderLegacy and fires onSortPersist", () => {
    const seen: ChartSpec[] = [];
    const onSortPersist = vi.fn();
    render(
      <InteractiveChartCard
        chart={singleSeries()}
        onSortPersist={onSortPersist}
        renderLegacy={(s) => {
          seen.push(s);
          return <div data-testid="legacy" />;
        }}
      />,
    );

    const control = screen.getByTestId("chart-sort-control") as HTMLSelectElement;
    fireEvent.change(control, { target: { value: "category-asc" } });

    const last = seen[seen.length - 1]!;
    expect(last.data?.map((r) => r.Age)).toEqual(["5", "10", "25"]);
    expect(onSortPersist).toHaveBeenCalledWith({ by: "category", direction: "asc" });
  });

  it("never scrambles seriesKeys when re-ordering a grouped/stacked bar", () => {
    const seen: ChartSpec[] = [];
    render(
      <InteractiveChartCard
        chart={multiSeries()}
        renderLegacy={(s) => {
          seen.push(s);
          return <div data-testid="legacy" />;
        }}
      />,
    );
    const control = screen.getByTestId("chart-sort-control") as HTMLSelectElement;
    fireEvent.change(control, { target: { value: "category-asc" } });

    const last = seen[seen.length - 1]!;
    expect(last.data?.map((r) => r.Age)).toEqual(["5", "10", "25"]);
    expect(last.seriesKeys).toEqual(["M", "F"]);
  });

  it("hides the sort control for non-bar charts", () => {
    render(
      <InteractiveChartCard
        chart={{ ...singleSeries(), type: "line" }}
        renderLegacy={() => <div data-testid="legacy" />}
      />,
    );
    expect(screen.queryByTestId("chart-sort-control")).toBeNull();
  });

  // Wave B2 · the v2 (Chart v1→v2 convergence) path must ALSO expose the sort
  // control and re-order the v2 spec's source rows — pre-B2 it silently dropped.
  const v2Bar = () =>
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
    }) as never;

  it("shows the sort control for a v2 bar and re-orders its source rows", () => {
    render(
      <InteractiveChartCard chart={v2Bar()} renderLegacy={() => <div />} />,
    );
    const control = screen.getByTestId("chart-sort-control") as HTMLSelectElement;
    fireEvent.change(control, { target: { value: "value-desc" } });
    expect(screen.getByTestId("v2-order").textContent).toBe(
      "male,female,other",
    );
  });

  it("hides the sort control for a v2 line mark", () => {
    const v2Line = { ...(v2Bar() as object), mark: "line" } as never;
    render(
      <InteractiveChartCard chart={v2Line} renderLegacy={() => <div />} />,
    );
    expect(screen.queryByTestId("chart-sort-control")).toBeNull();
  });
});
