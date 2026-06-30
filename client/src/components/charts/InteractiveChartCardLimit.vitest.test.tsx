// W8 · InteractiveChartCard exposes the same inline Top/Bottom-N limit control +
// "View all N" CTA the dashboard tile has, persisted via onSpecPersist.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartSpec } from "@/shared/schema";

vi.mock("./ChartShim", () => ({
  ChartShim: ({ legacy }: { legacy: () => unknown }) => <div>{legacy() as never}</div>,
}));
vi.mock("./ChartTilePivotView", () => ({
  ChartTilePivotView: () => <div data-testid="pivot-stub" />,
}));

import { InteractiveChartCard } from "./InteractiveChartCard";

afterEach(() => cleanup());

// A single-series bar with `count` distinct categories so the limit gates fire.
const barWith = (count: number): ChartSpec => ({
  type: "bar",
  title: "Sales by rep",
  x: "Rep",
  y: "Sales",
  data: Array.from({ length: count }, (_, i) => ({ Rep: `R${i}`, Sales: count - i })),
});

function mount(spec: ChartSpec, onSpecPersist = vi.fn()) {
  render(
    <InteractiveChartCard
      chart={spec}
      onSpecPersist={onSpecPersist}
      renderLegacy={() => <div data-testid="legacy" />}
    />,
  );
  return onSpecPersist;
}

describe("InteractiveChartCard · inline limit + View-all CTA (W8)", () => {
  it("shows the Top/Bottom-N control for a bar with > 10 categories", () => {
    mount(barWith(15));
    expect(screen.getByTestId("chart-limit-control")).toBeTruthy();
  });

  it("does NOT show the limit control at <= 10 categories", () => {
    mount(barWith(9));
    expect(screen.queryByTestId("chart-limit-control")).toBeNull();
  });

  it("persists the limit selection via onSpecPersist", () => {
    const onSpecPersist = mount(barWith(15));
    fireEvent.change(screen.getByTestId("chart-limit-control"), {
      target: { value: "top" },
    });
    expect(onSpecPersist).toHaveBeenCalledWith({ limit: { mode: "top", n: 10 } });
  });

  it("shows the 'View all N' CTA above 12 categories and flips to the pivot table", () => {
    mount(barWith(15));
    const cta = screen.getByText(/View all 15 .* as a sortable table/);
    expect(cta).toBeTruthy();
    fireEvent.click(cta);
    expect(screen.getByTestId("chart-pivot-body")).toBeTruthy();
  });

  it("does NOT show the 'View all N' CTA between 11 and 12 categories", () => {
    mount(barWith(11));
    expect(screen.queryByText(/View all .* as a sortable table/)).toBeNull();
  });
});
