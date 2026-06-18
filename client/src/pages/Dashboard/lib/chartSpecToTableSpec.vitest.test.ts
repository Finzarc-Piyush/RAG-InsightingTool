import { describe, expect, it } from "vitest";
import { chartSpecToTableSpec } from "./chartSpecToTableSpec";
import type { ChartSpec } from "@/shared/schema";

/**
 * WD-add · the chart→table derivation backs "Add → Table from session".
 * It must produce a schema-valid DashboardTableSpec (non-empty caption,
 * ≥1 column, cells limited to string|number|null) or null when there are
 * no rows to add.
 */

function baseChart(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type: "bar",
    title: "Revenue by Region",
    x: "region",
    y: "revenue",
    data: [
      { region: "North", revenue: 100 },
      { region: "South", revenue: 80 },
    ],
    ...overrides,
  } as ChartSpec;
}

describe("chartSpecToTableSpec", () => {
  it("derives caption, columns, and aligned rows from a chart's data", () => {
    const spec = chartSpecToTableSpec(baseChart())!;
    expect(spec).not.toBeNull();
    expect(spec.caption).toBe("Revenue by Region");
    // x first, then y (dimension → measure).
    expect(spec.columns).toEqual(["region", "revenue"]);
    expect(spec.rows).toEqual([
      ["North", 100],
      ["South", 80],
    ]);
  });

  it("front-loads x, then seriesColumn, then y", () => {
    const spec = chartSpecToTableSpec(
      baseChart({
        seriesColumn: "channel",
        data: [{ revenue: 5, channel: "Online", region: "North" }],
      }),
    )!;
    expect(spec.columns).toEqual(["region", "channel", "revenue"]);
    expect(spec.rows).toEqual([["North", "Online", 5]]);
  });

  it("collects columns present only in later rows", () => {
    const spec = chartSpecToTableSpec(
      baseChart({
        x: "region",
        y: "revenue",
        data: [
          { region: "North", revenue: 1 },
          { region: "South", revenue: 2, note: "spike" },
        ],
      }),
    )!;
    expect(spec.columns).toContain("note");
    // Missing cell in the first row is filled with null, aligned to columns.
    const noteIdx = spec.columns.indexOf("note");
    expect(spec.rows[0][noteIdx]).toBeNull();
    expect(spec.rows[1][noteIdx]).toBe("spike");
  });

  it("never emits a duplicate column when x / seriesColumn / y reuse a field", () => {
    // Count/histogram charts often set y to the same field as x.
    const spec = chartSpecToTableSpec(
      baseChart({
        x: "region",
        y: "region",
        seriesColumn: "region",
        data: [{ region: "North" }, { region: "South" }],
      }),
    )!;
    expect(spec.columns).toEqual(["region"]);
    expect(new Set(spec.columns).size).toBe(spec.columns.length);
    expect(spec.rows).toEqual([["North"], ["South"]]);
  });

  it("returns null when the chart has no embedded rows", () => {
    expect(chartSpecToTableSpec(baseChart({ data: [] }))).toBeNull();
    expect(chartSpecToTableSpec(baseChart({ data: undefined }))).toBeNull();
  });

  it("falls back to a synthesized caption when title is blank", () => {
    const spec = chartSpecToTableSpec(baseChart({ title: "   " }))!;
    expect(spec.caption).toBe("revenue by region");
  });

  it("coerces non-string/number cells to keep the spec schema-valid", () => {
    const spec = chartSpecToTableSpec(
      baseChart({ data: [{ region: "North", revenue: true as unknown as number }] }),
    )!;
    const revIdx = spec.columns.indexOf("revenue");
    expect(spec.rows[0][revIdx]).toBe("true");
  });
});
