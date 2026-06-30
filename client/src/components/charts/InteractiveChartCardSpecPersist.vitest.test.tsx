// W7 · InteractiveChartCard persists the parity toolbar's view-side mutations
// (mark switch / stacked-grouped / show-labels) via onSpecPersist, so the chat
// side is durable like the dashboard. Mirrors the Sort test's ChartShim mock.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartSpec } from "@/shared/schema";

vi.mock("./ChartShim", () => ({
  ChartShim: ({ legacy }: { legacy: () => unknown }) => <div>{legacy() as never}</div>,
}));

import { InteractiveChartCard } from "./InteractiveChartCard";

afterEach(() => cleanup());

// A multi-series bar so the Type, Layout, and Show-labels controls all render.
const barSpec = (): ChartSpec => ({
  type: "bar",
  title: "Sales by region",
  x: "Region",
  y: "Sales",
  seriesColumn: "Year",
  seriesKeys: ["2023", "2024"],
  barLayout: "stacked",
  data: [
    { Region: "North", "2023": 10, "2024": 12 },
    { Region: "South", "2023": 8, "2024": 9 },
  ],
});

function mount(onSpecPersist = vi.fn()) {
  render(
    <InteractiveChartCard
      chart={barSpec()}
      onSpecPersist={onSpecPersist}
      renderLegacy={() => <div data-testid="legacy" />}
    />,
  );
  return onSpecPersist;
}

describe("InteractiveChartCard · onSpecPersist (W7)", () => {
  it("persists the new mark when the Type dropdown changes", () => {
    const onSpecPersist = mount();
    fireEvent.change(screen.getByDisplayValue("Bar"), { target: { value: "line" } });
    expect(onSpecPersist).toHaveBeenCalledWith({ type: "line" });
  });

  it("persists the layout when Stacked/Grouped changes", () => {
    const onSpecPersist = mount();
    fireEvent.change(screen.getByDisplayValue("Stacked"), {
      target: { value: "grouped" },
    });
    expect(onSpecPersist).toHaveBeenCalledWith({ barLayout: "grouped" });
  });

  it("persists the show-labels toggle", () => {
    const onSpecPersist = mount();
    // dataLabels defaults to true (checked) → toggling sends false.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSpecPersist).toHaveBeenCalledWith({ dataLabels: false });
  });

  it("does not throw when onSpecPersist is omitted (ephemeral)", () => {
    render(
      <InteractiveChartCard chart={barSpec()} renderLegacy={() => <div />} />,
    );
    expect(() =>
      fireEvent.change(screen.getByDisplayValue("Bar"), { target: { value: "area" } }),
    ).not.toThrow();
  });
});
