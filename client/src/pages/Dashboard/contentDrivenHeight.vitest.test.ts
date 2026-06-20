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

  it("A2 · caps a long narrative at its DEFAULT height (current height as max)", () => {
    // A body that would compute to > the default h:10 must cap AT the default,
    // not at the generic 20-row ceiling — the narrative's own height is the max.
    const body = "x".repeat(60 * 50); // ~50 lines → would be 20 uncapped
    expect(contentDrivenHeight(narrativeTile(body), NARRATIVE_BASE, 6)).toBe(
      NARRATIVE_BASE.h,
    );
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

const INSIGHT_BASE = { w: 4, h: 7, minW: 2, minH: 2 };
const ACTION_BASE = { w: 4, h: 7, minW: 2, minH: 2 };
const TABLE_BASE = { w: 4, h: 8, minW: 2, minH: 3 };
const PIVOT_BASE = { w: 4, h: 12, minW: 3, minH: 4 };

function insightTile(narrative: string): DashboardTile {
  return { kind: "insight", id: "i1", title: "Insight", narrative } as DashboardTile;
}
function actionTile(recommendation: string): DashboardTile {
  return { kind: "action", id: "a1", title: "Action", recommendation } as DashboardTile;
}
function tableTile(rowCount: number): DashboardTile {
  return {
    kind: "table",
    id: "t1",
    title: "Table",
    index: 0,
    table: {
      columns: ["A", "B"],
      rows: Array.from({ length: rowCount }, (_, i) => [String(i), i]),
    },
  } as DashboardTile;
}
function pivotTile(): DashboardTile {
  return {
    kind: "pivot",
    id: "p1",
    title: "Pivot",
    index: 0,
    pivot: { id: "p1", title: "Pivot", pivotConfig: { rows: [], columns: [], values: [], filters: [], unused: [] } },
  } as DashboardTile;
}

describe("Wave S1 · contentDrivenHeight for text + table tiles", () => {
  it("sizes insight tiles to their narrative length", () => {
    expect(contentDrivenHeight(insightTile(""), INSIGHT_BASE, 4)).toBe(INSIGHT_BASE.minH);
    // 40 chars/line at w=4 → 4 lines + 2 padding = 6 rows.
    const out = contentDrivenHeight(insightTile("x".repeat(40 * 4)), INSIGHT_BASE, 4);
    expect(out).toBe(6);
  });

  it("sizes action tiles to their recommendation length", () => {
    const out = contentDrivenHeight(actionTile("x".repeat(40 * 2)), ACTION_BASE, 4);
    expect(out).toBe(4); // 2 lines + 2 padding
  });

  it("sizes tables to header + row count", () => {
    // 2 data rows → 3 header + 2 = 5 rows.
    expect(contentDrivenHeight(tableTile(2), TABLE_BASE, 4)).toBe(5);
  });

  it("clamps a tiny table up to minH and a huge table to the row ceiling", () => {
    // 0 rows → 3 header, but minH=3 floor → 3.
    expect(contentDrivenHeight(tableTile(0), TABLE_BASE, 4)).toBe(3);
    // 30 rows → 3 header + min(30, 8) = 11.
    expect(contentDrivenHeight(tableTile(30), TABLE_BASE, 4)).toBe(11);
  });

  it("leaves chart and pivot tiles on their base height without grid geometry", () => {
    expect(contentDrivenHeight(chartTile(), CHART_BASE, 4)).toBe(14);
    expect(contentDrivenHeight(pivotTile(), PIVOT_BASE, 4)).toBe(12);
  });

  it("sizes chart tiles by aspect ratio when grid geometry is provided (S3)", () => {
    const grid = { cols: 12, rowHeight: 32, gridMargin: [16, 16] as [number, number] };
    const narrow = contentDrivenHeight(chartTile(), CHART_BASE, 4, grid);
    const wide = contentDrivenHeight(chartTile(), CHART_BASE, 12, grid);
    // No longer pinned to the fixed 14; wider charts get taller.
    expect(narrow).not.toBe(14);
    expect(wide).toBeGreaterThan(narrow);
    // Pivot still ignores grid geometry (intrinsic sizing).
    expect(contentDrivenHeight(pivotTile(), PIVOT_BASE, 4, grid)).toBe(12);
  });
});
