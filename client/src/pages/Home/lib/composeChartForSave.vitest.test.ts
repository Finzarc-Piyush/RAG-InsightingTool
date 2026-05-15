import { describe, expect, it } from "vitest";
import { composeChartForSave } from "./composeChartForSave";
import type { ChartSpec } from "@/shared/schema";

const baseChart: ChartSpec = {
  type: "bar",
  title: "Sales by Region",
  x: "Region",
  y: "Sales",
} as ChartSpec;

describe("DR18C · composeChartForSave", () => {
  it("returns the chart unchanged when no live insight is provided", () => {
    expect(composeChartForSave(baseChart, undefined)).toBe(baseChart);
    expect(composeChartForSave(baseChart, null)).toBe(baseChart);
    expect(composeChartForSave(baseChart, "")).toBe(baseChart);
    expect(composeChartForSave(baseChart, "   ")).toBe(baseChart);
  });

  it("fills keyInsight when the chart has none and a live insight is provided", () => {
    const out = composeChartForSave(baseChart, "Region North leads at 42%.");
    expect(out).not.toBe(baseChart);
    expect(out.keyInsight).toBe("Region North leads at 42%.");
    expect(out.title).toBe(baseChart.title);
  });

  it("trims whitespace from the live insight before merging", () => {
    const out = composeChartForSave(baseChart, "  trimmed  ");
    expect(out.keyInsight).toBe("trimmed");
  });

  it("does NOT clobber a curated keyInsight (agent-stamped insights are preserved)", () => {
    const curated: ChartSpec = { ...baseChart, keyInsight: "Curated agent text." };
    const out = composeChartForSave(curated, "Live insight that should not win.");
    expect(out).toBe(curated);
    expect(out.keyInsight).toBe("Curated agent text.");
  });

  it("treats whitespace-only existing keyInsight as empty (live insight wins)", () => {
    const blank: ChartSpec = { ...baseChart, keyInsight: "   " };
    const out = composeChartForSave(blank, "real insight");
    expect(out.keyInsight).toBe("real insight");
  });

  it("preserves all other ChartSpec fields verbatim on merge", () => {
    const rich: ChartSpec = {
      ...baseChart,
      seriesColumn: "Segment",
      barLayout: "stacked",
      data: [{ Region: "North", Sales: 1, Segment: "A" }],
    } as ChartSpec;
    const out = composeChartForSave(rich, "live");
    expect(out.seriesColumn).toBe("Segment");
    expect(out.barLayout).toBe("stacked");
    expect(out.data).toBe(rich.data);
    expect(out.keyInsight).toBe("live");
  });
});
