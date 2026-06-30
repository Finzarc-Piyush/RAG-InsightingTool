// W10 · InteractiveChartCard exposes an explicit Maximize button (parity with
// the dashboard tile) that opens the rich ChartModal — the same modal
// ChartRenderer opens on header-click, just a discoverable icon trigger.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartSpec } from "@/shared/schema";

vi.mock("./ChartShim", () => ({
  ChartShim: ({ legacy }: { legacy: () => unknown }) => <div>{legacy() as never}</div>,
}));
// Stub the lazy modal so we can assert it opens without pulling in recharts.
vi.mock("@/pages/Home/Components/ChartModal", () => ({
  ChartModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="chart-modal-stub" /> : null,
}));

import { InteractiveChartCard } from "./InteractiveChartCard";

afterEach(() => cleanup());

const barSpec = (): ChartSpec => ({
  type: "bar",
  title: "Sales by region",
  x: "Region",
  y: "Sales",
  data: [
    { Region: "North", Sales: 10 },
    { Region: "South", Sales: 8 },
  ],
});

describe("InteractiveChartCard · Maximize button (W10)", () => {
  it("renders an explicit Expand button for a v1 chart", () => {
    render(<InteractiveChartCard chart={barSpec()} renderLegacy={() => <div />} />);
    expect(screen.getByTestId("chart-expand-button")).toBeTruthy();
  });

  it("opens the rich ChartModal when clicked", async () => {
    render(<InteractiveChartCard chart={barSpec()} renderLegacy={() => <div />} />);
    expect(screen.queryByTestId("chart-modal-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-expand-button"));
    expect(await screen.findByTestId("chart-modal-stub")).toBeTruthy();
  });

  it("can be suppressed via controls.expand = false", () => {
    render(
      <InteractiveChartCard
        chart={barSpec()}
        controls={{ expand: false }}
        renderLegacy={() => <div />}
      />,
    );
    expect(screen.queryByTestId("chart-expand-button")).toBeNull();
  });
});
