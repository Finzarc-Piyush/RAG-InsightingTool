import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * DR3 · regression coverage for the tile chrome refactor.
 *
 * The `draggableCancel` selector at the bottom of `DashboardTiles.tsx`
 * is load-bearing for the swap-on-collision UX: when a user clicks a
 * delete or edit button inside a tile, react-grid-layout must NOT
 * treat that click as the start of a drag. The selector explicitly
 * names every tile kind via the `data-dashboard-tile` attribute and
 * targets `button` (plus textarea/input on narrative for the inline
 * editor) inside each.
 *
 * The DR3 refactor pulled the per-tile header markup into a shared
 * `TileHeader`. If a future change reshapes the tile DOM such that
 * the `data-dashboard-tile` attribute moves off the outer card OR the
 * action buttons render outside the tile container (e.g. via a
 * portal), drag would fire on every action click. This test pins
 * both invariants by reading the source — cheap, deterministic, no
 * jsdom needed.
 */

const TILES_SRC = path.join(
  process.cwd(),
  "src/pages/Dashboard/Components/DashboardTiles.tsx",
);
// DR18D · the chart-tile body was extracted into its own component so
// the chart/pivot view-mode hook could host its state. The
// `data-dashboard-tile="chart"` and `dashboard-tile-grab-area` markers
// moved with it — assert against this file for the chart kind.
const CHART_BODY_SRC = path.join(
  process.cwd(),
  "src/pages/Dashboard/Components/ChartTileBody.tsx",
);

const KINDS = ["chart", "insight", "narrative", "table", "pivot"] as const;

describe("DashboardTiles · draggableCancel contract", () => {
  const tilesSource = fs.readFileSync(TILES_SRC, "utf8");
  const chartBodySource = fs.readFileSync(CHART_BODY_SRC, "utf8");

  /**
   * Helper: returns the source string that should declare the
   * `data-dashboard-tile="${kind}"` attribute. Chart lives in
   * ChartTileBody (DR18D); the others stay inline in DashboardTiles.
   */
  function sourceForKind(kind: string): { src: string; file: string } {
    if (kind === "chart") return { src: chartBodySource, file: "ChartTileBody.tsx" };
    return { src: tilesSource, file: "DashboardTiles.tsx" };
  }

  it("each non-pivot tile kind carries the data-dashboard-tile attribute", () => {
    // Pivot is rendered via PivotTile (its own component); the others
    // declare the attribute on their respective outer Cards.
    for (const kind of ["chart", "insight", "narrative", "table"] as const) {
      const { src, file } = sourceForKind(kind);
      expect(
        src.includes(`data-dashboard-tile="${kind}"`),
        `expected data-dashboard-tile="${kind}" in ${file}`,
      ).toBe(true);
    }
  });

  it("draggableCancel selector references every tile kind", () => {
    // The selector itself stays on `<ResponsiveGridLayout>` in
    // DashboardTiles.tsx because that's where the grid lives.
    const selectorMatch = tilesSource.match(/draggableCancel="([^"]+)"/);
    expect(
      selectorMatch,
      "expected a draggableCancel attribute on the grid layout",
    ).toBeTruthy();
    const selector = selectorMatch![1];
    for (const kind of KINDS) {
      expect(
        selector.includes(`data-dashboard-tile='${kind}'`),
        `draggableCancel must include data-dashboard-tile='${kind}'`,
      ).toBe(true);
    }
    // Buttons across every kind plus textarea/input for narrative.
    expect(selector).toMatch(/\bbutton\b/);
    expect(selector).toMatch(/narrative'\] textarea/);
    expect(selector).toMatch(/narrative'\] input/);
  });

  it("dashboard-tile-grab-area class is on the outer card for every non-pivot kind", () => {
    // The grab-area class is what react-grid-layout's draggableHandle
    // selects. Without it on the outer Card, dragging from the title
    // strip would not initiate a drag and the swap-on-collision test
    // suite would silently never exercise.
    let count = 0;
    for (const kind of ["chart", "insight", "narrative", "table"] as const) {
      const { src, file } = sourceForKind(kind);
      const matches = Array.from(
        src.matchAll(new RegExp(`data-dashboard-tile="${kind}"`, "g")),
      );
      expect(matches.length, `${kind} attribute must appear in ${file}`).toBeGreaterThanOrEqual(1);
      for (const m of matches) {
        // For each match, look back ~500 chars to find the dashboard-tile-
        // grab-area class on the same Card opening tag.
        const start = Math.max(0, m.index! - 500);
        const window = src.slice(start, m.index! + 50);
        expect(
          window.includes("dashboard-tile-grab-area"),
          `dashboard-tile-grab-area must be on the same outer Card as data-dashboard-tile="${kind}" in ${file}`,
        ).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(4);
  });
});
