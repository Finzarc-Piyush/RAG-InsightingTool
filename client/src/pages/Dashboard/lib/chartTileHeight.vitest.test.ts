import { describe, expect, it } from "vitest";
import { chartAspectRows, chartAspectRowsForChart } from "./chartTileHeight";
import type { ChartSpec } from "@/shared/schema";

const COLS = 12;
const ROW_HEIGHT = 32;
const MARGIN: [number, number] = [16, 16];

const chart = (p: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", title: "c", x: "Region", y: "Sales", ...p }) as ChartSpec;

describe("Wave S2 · chartAspectRows", () => {
  it("floors a narrow chart at minRows (kills the fixed-h14 dead space)", () => {
    const rows = chartAspectRows(3, COLS, ROW_HEIGHT, MARGIN, { minRows: 9 });
    expect(rows).toBe(9);
    // Shorter than the legacy fixed default of 14.
    expect(rows).toBeLessThan(14);
  });

  it("scales taller as the tile gets wider", () => {
    const narrow = chartAspectRows(4, COLS, ROW_HEIGHT, MARGIN);
    const wide = chartAspectRows(12, COLS, ROW_HEIGHT, MARGIN);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("clamps within [minRows, maxRows] for every span", () => {
    for (let w = 1; w <= COLS; w++) {
      const rows = chartAspectRows(w, COLS, ROW_HEIGHT, MARGIN, {
        minRows: 9,
        maxRows: 16,
      });
      expect(rows).toBeGreaterThanOrEqual(9);
      expect(rows).toBeLessThanOrEqual(16);
    }
  });

  it("clamps to maxRows for an extreme container width", () => {
    const rows = chartAspectRows(12, COLS, ROW_HEIGHT, MARGIN, {
      maxRows: 16,
      containerWidth: 100000,
    });
    expect(rows).toBe(16);
  });

  it("is monotonic non-decreasing in ratio", () => {
    const low = chartAspectRows(12, COLS, ROW_HEIGHT, MARGIN, { ratio: 0.4, maxRows: 99 });
    const high = chartAspectRows(12, COLS, ROW_HEIGHT, MARGIN, { ratio: 0.9, maxRows: 99 });
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it("treats an over-wide span as full width (no overflow)", () => {
    const full = chartAspectRows(12, COLS, ROW_HEIGHT, MARGIN);
    const over = chartAspectRows(20, COLS, ROW_HEIGHT, MARGIN);
    expect(over).toBe(full);
  });
});

describe("chartAspectRowsForChart · bar floor", () => {
  it("makes a narrow bar taller than the same-width line", () => {
    const line = chartAspectRowsForChart(chart({ type: "line" }), 4, COLS, ROW_HEIGHT, MARGIN);
    const bar = chartAspectRowsForChart(chart({ type: "bar", data: [{}, {}] }), 4, COLS, ROW_HEIGHT, MARGIN);
    // line keeps the pure aspect height; bar is floored taller.
    expect(line).toBe(chartAspectRows(4, COLS, ROW_HEIGHT, MARGIN));
    expect(bar).toBeGreaterThan(line);
    expect(bar).toBeGreaterThanOrEqual(12);
  });

  it("makes a many-category bar tallest", () => {
    const few = chartAspectRowsForChart(chart({ type: "bar", data: [{}, {}] }), 4, COLS, ROW_HEIGHT, MARGIN);
    const many = chartAspectRowsForChart(
      chart({ type: "bar", data: Array.from({ length: 20 }, () => ({})) }),
      4,
      COLS,
      ROW_HEIGHT,
      MARGIN,
    );
    expect(many).toBeGreaterThan(few);
    expect(many).toBeGreaterThanOrEqual(14);
  });
});
