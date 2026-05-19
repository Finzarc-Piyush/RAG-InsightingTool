/**
 * Wave WD2-dim-rect · source-inspection tests for the RectRenderer
 * (heatmap) two-dim dim. Pairs structurally with the WD2-wiring-rest-rect
 * two-dim DISPATCH (which fires both `rowCh.field` and `colCh.field`
 * events in row-first order on click) but takes a different *shape*:
 * dispatch is AND (both events fire); dim is OR (cell is dimmed if
 * EITHER an active row filter excludes the row OR an active col
 * filter excludes the col).
 *
 * The OR contract means a row-only filter dims along rows only, a
 * col-only filter dims along cols only, and a row+col filter
 * intersects: the only cells at full opacity are those that pass
 * BOTH the row filter AND the col filter. Matches the user's mental
 * model of "show me the cells that survive the filter intersection"
 * — a row+col filter on (region=North, channel=Modern Trade) keeps
 * only the (North, Modern Trade) cell at full opacity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const rectSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/RectRenderer.tsx"),
  "utf-8",
);

describe("WD2-dim-rect · RectRenderer imports isCrossFilterActive", () => {
  it("named-imports isCrossFilterActive alongside dispatchCrossFilter + toFilterValue", () => {
    assert.match(
      rectSrc,
      /import \{[\s\S]*?dispatchCrossFilter,[\s\S]*?isCrossFilterActive,[\s\S]*?toFilterValue,[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });
});

describe("WD2-dim-rect · two-dim lifted locals (one per row/col dimension)", () => {
  it("lifts dashboardFilters once at the top of the render body", () => {
    assert.match(
      rectSrc,
      /const dashboardFilters = dashboardTile\?\.filters;/,
    );
  });

  it("reads rowCh.field and colCh.field selections separately", () => {
    assert.match(
      rectSrc,
      /const rowFilterSel = dashboardFilters\?\.\[rowCh\.field\];/,
    );
    assert.match(
      rectSrc,
      /const colFilterSel = dashboardFilters\?\.\[colCh\.field\];/,
    );
  });

  it("computes dashboardRowDimActive + dashboardColDimActive with the full triple-guard (selection exists + categorical + non-empty)", () => {
    assert.match(
      rectSrc,
      /const dashboardRowDimActive =\s*!!rowFilterSel &&\s*rowFilterSel\.type === "categorical" &&\s*rowFilterSel\.values\.length > 0;/,
    );
    assert.match(
      rectSrc,
      /const dashboardColDimActive =\s*!!colFilterSel &&\s*colFilterSel\.type === "categorical" &&\s*colFilterSel\.values\.length > 0;/,
    );
  });
});

describe("WD2-dim-rect · per-cell isDashboardDimmed is OR of row-dim and col-dim", () => {
  it("isRowDimmed checks isCrossFilterActive against rowRawByKey.get(row) on rowCh.field", () => {
    assert.match(
      rectSrc,
      /const isRowDimmed =\s*dashboardRowDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*rowCh\.field,\s*rowRawByKey\.get\(row\),\s*\);/,
    );
  });

  it("isColDimmed checks isCrossFilterActive against colRawByKey.get(col) on colCh.field", () => {
    assert.match(
      rectSrc,
      /const isColDimmed =\s*dashboardColDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*colCh\.field,\s*colRawByKey\.get\(col\),\s*\);/,
    );
  });

  it("isDashboardDimmed is the OR of the two (cell is dim if EITHER dim's filter excludes it)", () => {
    assert.match(
      rectSrc,
      /const isDashboardDimmed = isRowDimmed \|\| isColDimmed;/,
    );
  });

  it("uses rowRawByKey + colRawByKey lookups (NOT the stringified row / col keys)", () => {
    // The raw values are what the cross-filter stored when the user
    // clicked another tile's mark; comparing stringified row / col
    // against raw values would always miss for non-string dims (Date,
    // number, boolean). Pin the raw-lookup invariant — same pattern
    // as the WD2-wiring-rest-rect dispatch carries raw values.
    assert.doesNotMatch(
      rectSrc,
      /isCrossFilterActive\([^,]+,\s*rowCh\.field,\s*row\s*,/,
    );
    assert.doesNotMatch(
      rectSrc,
      /isCrossFilterActive\([^,]+,\s*colCh\.field,\s*col\s*,/,
    );
  });
});

describe("WD2-dim-rect · fillOpacity binding", () => {
  it("cell <rect> renders fillOpacity={isDashboardDimmed ? 0.4 : 1} (no prior baseline)", () => {
    // RectRenderer cells had no fillOpacity before WD2-dim-rect; the
    // new prop is the pure dim factor with 1 as the default (matched
    // cells stay at full opacity).
    assert.match(
      rectSrc,
      /fillOpacity=\{isDashboardDimmed \? 0\.4 : 1\}/,
    );
  });

  it("stroke / strokeWidth on cells are untouched (structural grid lines, not the filterable mark)", () => {
    // The 0.5-px background stroke on every cell is the heatmap's grid
    // — dimming it would visually flatten the heatmap. Pin that the
    // stroke styling stays decoupled from isDashboardDimmed.
    assert.doesNotMatch(
      rectSrc,
      /stroke=\{isDashboardDimmed/,
    );
    assert.doesNotMatch(
      rectSrc,
      /strokeWidth=\{isDashboardDimmed/,
    );
  });
});

describe("WD2-dim-rect · lifted locals live outside the per-cell map", () => {
  it("dashboardRowDimActive + dashboardColDimActive computed BEFORE the per-cell map", () => {
    const liftRow = rectSrc.indexOf("const dashboardRowDimActive =");
    const liftCol = rectSrc.indexOf("const dashboardColDimActive =");
    // Find the cell-rendering map — the body does an inner `.map(...)`
    // that emits the per-cell <rect>. Locate via the cell <rect> tag.
    const usage = rectSrc.indexOf("<rect\n                key={`${row}-${col}`}");
    assert.ok(liftRow >= 0 && liftCol >= 0 && usage >= 0);
    assert.ok(liftRow < usage && liftCol < usage);
  });
});

describe("WD2-dim-rect · documentation comment names the OR contract", () => {
  it("the lifted-locals comment names OR-of-row-OR-col explicitly", () => {
    assert.match(rectSrc, /OR-of-row-OR-col/);
  });

  it("documents the symmetric pairing with the WD2-wiring-rest-rect two-dim dispatch", () => {
    // Future Claude reading the file should see the AND-dispatch /
    // OR-dim asymmetry called out — otherwise the OR contract looks
    // like a divergence from the dispatch shape, not a deliberate
    // mental-model match.
    assert.match(rectSrc, /two-dim DISPATCH/);
  });
});
