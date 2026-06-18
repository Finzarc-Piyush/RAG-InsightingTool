// Wave S4 · ChartSortControl — the "Sort by ▾" dropdown.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChartSortControl } from "./ChartSortControl";
import type { ChartSortSpec } from "@/shared/chartSort";

afterEach(() => cleanup());

const getSelect = () =>
  screen.getByTestId("chart-sort-control") as HTMLSelectElement;

describe("ChartSortControl", () => {
  it("offers exactly the four sort combinations", () => {
    render(<ChartSortControl value={undefined} onChange={() => {}} axisLabel="Age" />);
    const opts = Array.from(getSelect().options).map((o) => o.value);
    expect(opts).toEqual(["value-desc", "value-asc", "category-asc", "category-desc"]);
  });

  it("labels the axis options with the provided axisLabel", () => {
    render(<ChartSortControl value={undefined} onChange={() => {}} axisLabel="Age" />);
    const labels = Array.from(getSelect().options).map((o) => o.textContent);
    expect(labels).toContain("By Age (ascending)");
    expect(labels).toContain("By Age (descending)");
  });

  it("falls back to 'axis' when no axisLabel is given", () => {
    render(<ChartSortControl value={undefined} onChange={() => {}} />);
    const labels = Array.from(getSelect().options).map((o) => o.textContent);
    expect(labels).toContain("By axis (ascending)");
  });

  it("reflects the current value (defaults to value-desc when undefined)", () => {
    const { rerender } = render(
      <ChartSortControl value={undefined} onChange={() => {}} />,
    );
    expect(getSelect().value).toBe("value-desc");
    rerender(
      <ChartSortControl
        value={{ by: "category", direction: "asc" }}
        onChange={() => {}}
      />,
    );
    expect(getSelect().value).toBe("category-asc");
  });

  it("emits a parsed ChartSortSpec on change", () => {
    const onChange = vi.fn();
    render(<ChartSortControl value={undefined} onChange={onChange} axisLabel="Age" />);
    fireEvent.change(getSelect(), { target: { value: "category-asc" } });
    const arg = onChange.mock.calls[0]?.[0] as ChartSortSpec;
    expect(arg).toEqual({ by: "category", direction: "asc" });
  });
});
