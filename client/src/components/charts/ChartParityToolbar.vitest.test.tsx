// W3 · ChartParityToolbar — the shared mark-switch / layout / show-labels
// cluster mounted by both the chat card and the dashboard tile. These tests pin
// the self-gating rules (which control shows for which mark) and the callbacks,
// so the two surfaces stay in lockstep.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { ChartParityToolbar, isSwitchableMark } from "./ChartParityToolbar";

afterEach(() => cleanup());

const noop = () => {};

function mount(props: Partial<React.ComponentProps<typeof ChartParityToolbar>> = {}) {
  return render(
    <ChartParityToolbar
      type="bar"
      hasSeries
      onTypeChange={noop}
      onBarLayoutChange={noop}
      onDataLabelsChange={noop}
      {...props}
    />,
  );
}

describe("isSwitchableMark", () => {
  it("is true for bar/line/area, false otherwise", () => {
    expect(isSwitchableMark("bar")).toBe(true);
    expect(isSwitchableMark("line")).toBe(true);
    expect(isSwitchableMark("area")).toBe(true);
    expect(isSwitchableMark("pie")).toBe(false);
    expect(isSwitchableMark("scatter")).toBe(false);
  });
});

describe("ChartParityToolbar · self-gating per mark", () => {
  it("a bar with a series shows Type, Layout, and Show labels", () => {
    mount({ type: "bar", hasSeries: true });
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("Layout")).toBeTruthy();
    expect(screen.getByText("Show labels")).toBeTruthy();
  });

  it("a bar WITHOUT a series hides the Layout toggle (nothing to stack)", () => {
    mount({ type: "bar", hasSeries: false });
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.queryByText("Layout")).toBeNull();
    expect(screen.getByText("Show labels")).toBeTruthy();
  });

  it("a line shows Type + Show labels but no Layout", () => {
    mount({ type: "line", hasSeries: true });
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.queryByText("Layout")).toBeNull();
    expect(screen.getByText("Show labels")).toBeTruthy();
  });

  it("a scatter shows only Show labels (not a switchable mark)", () => {
    mount({ type: "scatter", hasSeries: false });
    expect(screen.queryByText("Type")).toBeNull();
    expect(screen.queryByText("Layout")).toBeNull();
    expect(screen.getByText("Show labels")).toBeTruthy();
  });

  it("a pie renders nothing at all (no control applies)", () => {
    const { container } = mount({ type: "pie", hasSeries: false });
    expect(container.textContent).toBe("");
  });

  it("respects per-control visibility overrides via `show`", () => {
    mount({ type: "bar", hasSeries: true, show: { chartType: false } });
    expect(screen.queryByText("Type")).toBeNull();
    expect(screen.getByText("Layout")).toBeTruthy();
    expect(screen.getByText("Show labels")).toBeTruthy();
  });
});

describe("ChartParityToolbar · callbacks", () => {
  it("emits the new mark on Type change", () => {
    const onTypeChange = vi.fn();
    mount({ type: "bar", hasSeries: true, onTypeChange });
    fireEvent.change(screen.getByDisplayValue("Bar"), { target: { value: "line" } });
    expect(onTypeChange).toHaveBeenCalledWith("line");
  });

  it("emits the new layout on Layout change", () => {
    const onBarLayoutChange = vi.fn();
    mount({ type: "bar", hasSeries: true, barLayout: "stacked", onBarLayoutChange });
    fireEvent.change(screen.getByDisplayValue("Stacked"), {
      target: { value: "grouped" },
    });
    expect(onBarLayoutChange).toHaveBeenCalledWith("grouped");
  });

  it("emits the checkbox state on Show labels change", () => {
    const onDataLabelsChange = vi.fn();
    // dataLabels defaults to true → the checkbox starts checked; toggling sends false.
    mount({ type: "bar", hasSeries: true, dataLabels: true, onDataLabelsChange });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onDataLabelsChange).toHaveBeenCalledWith(false);
  });

  it("treats undefined dataLabels as checked (default on)", () => {
    mount({ type: "bar", hasSeries: true, dataLabels: undefined });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });
});
