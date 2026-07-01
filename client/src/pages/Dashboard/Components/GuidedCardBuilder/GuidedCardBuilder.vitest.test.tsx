// Wave W10–W12 (data-bound cards) · the guided card builder. Pins the feature's
// whole point — the aggregation GUARDRAIL: Sum is enabled for an additive
// measure (NR) and DISABLED for a ratio (GC%), with the explanatory tooltip.
// Also pins the selection-only filter chain (values come from topValues chips).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import type { BuilderMetadata } from "@/lib/api/dashboards";

// recharts (used by the scorecard preview) needs ResizeObserver.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { getBuilderMetadata, previewTile, composeTile } = vi.hoisted(() => ({
  getBuilderMetadata: vi.fn(),
  previewTile: vi.fn(),
  composeTile: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  dashboardsApi: { getBuilderMetadata, previewTile, composeTile },
}));

import { GuidedCardBuilderDialog } from "./GuidedCardBuilderDialog";
import { FilterChainEditor, type CardFilter } from "./FilterChainEditor";

afterEach(() => cleanup());

function meta(measuresFirst: "NR" | "GC%"): BuilderMetadata {
  const nr = {
    ref: "NR",
    kind: "column" as const,
    label: "Net Revenue",
    format: "number" as const,
    allowedAggregations: ["sum", "avg", "count", "min", "max", "median"] as const,
    defaultAggregation: "sum" as const,
  };
  const gc = {
    ref: "GC%",
    kind: "column" as const,
    label: "GC%",
    format: "percent" as const,
    allowedAggregations: ["avg"] as const,
    defaultAggregation: "avg" as const,
  };
  return {
    measures: measuresFirst === "NR" ? [nr, gc] : [gc, nr],
    dimensions: [
      { column: "Channel", label: "Channel", kind: "categorical", hasTopValues: true, values: [{ value: "GT", count: 5 }, { value: "MT", count: 3 }] },
    ],
  } as unknown as BuilderMetadata;
}

describe("GuidedCardBuilderDialog · aggregation guardrail", () => {
  beforeEach(() => {
    previewTile.mockResolvedValue({
      ok: true,
      cardType: "scorecard",
      scorecard: {
        id: "p",
        title: "x",
        cardDefinition: { cardType: "scorecard", measure: { kind: "column", ref: "NR", label: "NR" }, aggregation: "sum" },
        snapshot: { value: 100, tone: "neutral", computedAt: 1 },
      },
    });
  });

  it("enables Sum for an additive measure (NR)", async () => {
    getBuilderMetadata.mockResolvedValue(meta("NR"));
    render(
      <GuidedCardBuilderDialog dashboardId="d1" open onOpenChange={() => {}} onComposed={() => {}} />
    );
    const sum = (await screen.findByText("Sum")).closest("button")!;
    expect(sum.hasAttribute("disabled")).toBe(false);
  });

  it("DISABLES Sum for a ratio measure (GC%) with the 'can't sum a percentage' tooltip", async () => {
    getBuilderMetadata.mockResolvedValue(meta("GC%"));
    render(
      <GuidedCardBuilderDialog dashboardId="d1" open onOpenChange={() => {}} onComposed={() => {}} />
    );
    const sum = (await screen.findByText("Sum")).closest("button")!;
    await waitFor(() => expect(sum.hasAttribute("disabled")).toBe(true));
    expect(sum.getAttribute("title")).toMatch(/can't sum a percentage/i);
  });
});

describe("FilterChainEditor · selection-only values", () => {
  it("renders value chips from topValues and toggles them via onChange", () => {
    const filters: CardFilter[] = [{ column: "Channel", values: [] }];
    const onChange = vi.fn();
    render(
      <FilterChainEditor
        dimensions={[
          { column: "Channel", label: "Channel", kind: "categorical", hasTopValues: true, values: [{ value: "GT", count: 5 }, { value: "MT", count: 3 }] },
        ]}
        filters={filters}
        onChange={onChange}
      />
    );
    // The GT/MT value chips are rendered from topValues (never free-typed).
    const gt = screen.getByText("GT");
    fireEvent.click(gt);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as CardFilter[];
    expect(next[0].values).toContain("GT");
  });

  it("disables 'Add filter' when no dimension has value lists", () => {
    render(
      <FilterChainEditor
        dimensions={[{ column: "Notes", label: "Notes", kind: "categorical", hasTopValues: false }]}
        filters={[]}
        onChange={() => {}}
      />
    );
    const add = screen.getByText("Add filter").closest("button")!;
    expect(add.hasAttribute("disabled")).toBe(true);
  });
});
