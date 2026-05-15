import { describe, expect, it } from "vitest";
import { contentDrivenHeight } from "./contentDrivenHeight";
import type { DashboardTile } from "./types";

const NARRATIVE_BASE = { w: 6, h: 10, minW: 3, minH: 4 };
const CHART_BASE = { w: 4, h: 14, minW: 3, minH: 6 };

function narrativeTile(body: string): DashboardTile {
  return {
    kind: "narrative",
    id: `n-${body.length}`,
    title: "Limitations",
    block: { id: "b1", role: "limitations", title: "Limitations", body, order: 0 },
  } as DashboardTile;
}

function chartTile(): DashboardTile {
  return {
    kind: "chart",
    id: "c1",
    title: "Chart",
    chart: { type: "bar", title: "Chart", x: "x", y: "y" } as any,
    index: 0,
  } as DashboardTile;
}

describe("DR18A · contentDrivenHeight", () => {
  it("returns the base h for non-narrative kinds (charts unchanged)", () => {
    expect(contentDrivenHeight(chartTile(), CHART_BASE, 4)).toBe(14);
  });

  it("clamps short narrative to minH", () => {
    // Empty body → 0 lines + 2 padding = 2 rows, clamped to minH=4.
    expect(contentDrivenHeight(narrativeTile(""), NARRATIVE_BASE, 6)).toBe(4);
  });

  it("scales to medium-length narrative bodies", () => {
    // 60 chars/line at w=6 → ~7 lines + 2 padding = 9 rows.
    const body = "x".repeat(60 * 7);
    expect(contentDrivenHeight(narrativeTile(body), NARRATIVE_BASE, 6)).toBe(9);
  });

  it("caps at the 20-row ceiling for very long narratives", () => {
    const body = "x".repeat(60 * 50);
    expect(
      contentDrivenHeight(narrativeTile(body), NARRATIVE_BASE, 6),
    ).toBeLessThanOrEqual(20);
  });

  it("scales line-wrap budget with effective grid width", () => {
    const body = "x".repeat(120);
    // At full width (w=6 of 6 base) → 60 chars/line, body fits in 2 lines + 2 pad = 4.
    const wide = contentDrivenHeight(narrativeTile(body), NARRATIVE_BASE, 6);
    // At narrower placement (w=2 of 6 base) → ~20 chars/line, 6 lines + 2 pad = 8.
    const narrow = contentDrivenHeight(narrativeTile(body), NARRATIVE_BASE, 2);
    expect(narrow).toBeGreaterThan(wide);
  });

  it("never returns a value below minH for any narrative input", () => {
    for (const len of [0, 1, 5, 30, 100, 5000]) {
      const out = contentDrivenHeight(
        narrativeTile("x".repeat(len)),
        NARRATIVE_BASE,
        6,
      );
      expect(out).toBeGreaterThanOrEqual(NARRATIVE_BASE.minH);
    }
  });

  it("never exceeds the 20-row ceiling for any narrative input", () => {
    for (const len of [0, 100, 1000, 10000, 50000]) {
      const out = contentDrivenHeight(
        narrativeTile("x".repeat(len)),
        NARRATIVE_BASE,
        6,
      );
      expect(out).toBeLessThanOrEqual(20);
    }
  });
});
