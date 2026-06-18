// Wave S5 · InteractiveChartCard wires the "Sort by" control → instant re-order
// of the spec handed to renderLegacy + a persistence callback.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartSpec } from "@/shared/schema";

// Isolate the toolbar: ChartShim just renders the legacy slot for v1 specs.
vi.mock("./ChartShim", () => ({
  ChartShim: ({ legacy }: { legacy: () => unknown }) => <div>{legacy() as never}</div>,
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
});
