// ChartLimitControl — the "Show" Top-N / Bottom-N control for bar charts.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChartLimitControl, type ChartLimit } from "./ChartLimitControl";

afterEach(() => cleanup());

const getSelect = () =>
  screen.getByTestId("chart-limit-control") as HTMLSelectElement;
const queryN = () =>
  screen.queryByTestId("chart-limit-n") as HTMLInputElement | null;

describe("ChartLimitControl", () => {
  it("offers All / Top / Bottom and labels All with the total", () => {
    render(<ChartLimitControl value={null} onChange={() => {}} total={40} />);
    const opts = Array.from(getSelect().options).map((o) => o.value);
    expect(opts).toEqual(["all", "top", "bottom"]);
    const labels = Array.from(getSelect().options).map((o) => o.textContent);
    expect(labels).toContain("All (40)");
  });

  it("hides the N input when mode is All", () => {
    render(<ChartLimitControl value={null} onChange={() => {}} total={40} />);
    expect(getSelect().value).toBe("all");
    expect(queryN()).toBeNull();
  });

  it("shows the N input reflecting the current limit", () => {
    render(
      <ChartLimitControl value={{ mode: "top", n: 15 }} onChange={() => {}} total={40} />,
    );
    expect(getSelect().value).toBe("top");
    expect(queryN()).toBeTruthy();
    expect(queryN()!.value).toBe("15");
  });

  it("emits a {mode:'top', n:10} default when switching from All to Top", () => {
    const onChange = vi.fn();
    render(<ChartLimitControl value={null} onChange={onChange} total={40} />);
    fireEvent.change(getSelect(), { target: { value: "top" } });
    expect(onChange.mock.calls[0]?.[0]).toEqual({ mode: "top", n: 10 });
  });

  it("emits null when switching back to All", () => {
    const onChange = vi.fn();
    render(
      <ChartLimitControl value={{ mode: "top", n: 10 }} onChange={onChange} total={40} />,
    );
    fireEvent.change(getSelect(), { target: { value: "all" } });
    expect(onChange.mock.calls[0]?.[0]).toBeNull();
  });

  it("emits the typed N (clamped to [1, total]) preserving the mode", () => {
    const onChange = vi.fn();
    render(
      <ChartLimitControl value={{ mode: "bottom", n: 10 }} onChange={onChange} total={40} />,
    );
    fireEvent.change(queryN()!, { target: { value: "7" } });
    expect(onChange.mock.calls[0]?.[0]).toEqual({ mode: "bottom", n: 7 });
    // Over the total clamps down to the total.
    fireEvent.change(queryN()!, { target: { value: "999" } });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ mode: "bottom", n: 40 });
  });

  it("round-trips a value-controlled limit", () => {
    const value: ChartLimit = { mode: "top", n: 20 };
    render(<ChartLimitControl value={value} onChange={() => {}} total={50} />);
    expect(getSelect().value).toBe("top");
    expect(queryN()!.value).toBe("20");
  });
});
