/**
 * Wave WD2-wiring-rest-trend · source-inspection tests for LineRenderer
 * + AreaRenderer cross-filter wiring.
 *
 * Trend marks (continuous x) don't have per-mark click targets the way
 * Bar / Arc / Funnel / Box / Waterfall / Combo do. The dispatch reads
 * the click x-coordinate, finds the nearest x in any series, and fires
 * `dispatchCrossFilter` with that value.
 *
 *   - LineRenderer already has brush-zoom mouse handlers; the existing
 *     6-px click-vs-drag guard in `onBrushUp` is the natural place to
 *     attach the dispatch. The dispatch fires only on the click branch
 *     so a drag-to-zoom interaction never accidentally toggles a filter.
 *
 *   - AreaRenderer had no mouse handlers; this wave adds an svg-level
 *     `onClick` that uses `localPoint` to source the click position in
 *     svg coords, subtracts the left margin, and runs the same
 *     nearest-x lookup. Reads from the PRE-stack `series` (not
 *     `stacked`) so multi-series stacking doesn't skew the lookup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const lineSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/LineRenderer.tsx"),
  "utf-8",
);
const areaSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/AreaRenderer.tsx"),
  "utf-8",
);

describe("WD2-wiring-rest-trend · LineRenderer cross-filter wiring", () => {
  it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
    assert.match(
      lineSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
  });

  it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      lineSrc,
      /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("reads the dashboard-tile context once in the renderer body", () => {
    assert.match(lineSrc, /const dashboardTile = useDashboardTileContext\(\);/);
  });

  it("dispatch fires inside the existing onBrushUp click-treatment branch (Math.abs(hi - lo) < 6)", () => {
    // The dispatch must sit AFTER the 6-px guard but BEFORE the
    // brush-state reset so the recorded click position is still
    // available for the nearest-x lookup.
    assert.match(
      lineSrc,
      /if \(Math\.abs\(hi - lo\) < 6\) \{[\s\S]*?if \(dashboardTile\) \{[\s\S]*?dispatchCrossFilter\(\{[\s\S]*?\}\);[\s\S]*?\}[\s\S]*?setBrushStart\(null\);/,
    );
  });

  it("the nearest-x lookup scans every series.points to find the minimum |xPx(p.x) - clickX|", () => {
    assert.match(
      lineSrc,
      /for \(const s of series\) \{[\s\S]*?for \(const p of s\.points\) \{[\s\S]*?const px = xPx\(p\.x\);[\s\S]*?const dx = Math\.abs\(px - clickX\);[\s\S]*?if \(dx < minDx\)/,
    );
  });

  it("dispatches CROSS_FILTER_EVENT with { column: xCh.field, value: toFilterValue(nearest.x), sourceTileId }", () => {
    assert.match(
      lineSrc,
      /dispatchCrossFilter\(\{[\s\S]*?column: xCh\.field,[\s\S]*?value: toFilterValue\(nearest\.x\),[\s\S]*?sourceTileId: dashboardTile\.tileId,[\s\S]*?\}\);/,
    );
  });

  it("the dispatch is gated on dashboardTile being non-null AND a non-null nearest", () => {
    // Two guards: dashboardTile gates the cost of the nearest-x scan
    // (avoid running it on chat/explorer); nearest gates the dispatch
    // when an empty series list yields no candidate point.
    assert.match(lineSrc, /if \(dashboardTile\) \{[\s\S]*?if \(nearest\) \{[\s\S]*?dispatchCrossFilter/);
  });
});

describe("WD2-wiring-rest-trend · AreaRenderer cross-filter wiring", () => {
  it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
    assert.match(
      areaSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
  });

  it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      areaSrc,
      /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("imports localPoint from @visx/event for svg-relative click coords", () => {
    assert.match(areaSrc, /import \{ localPoint \} from "@visx\/event"/);
  });

  it("reads the dashboard-tile context once in the renderer body", () => {
    assert.match(areaSrc, /const dashboardTile = useDashboardTileContext\(\);/);
  });

  it("svg sets cursor:pointer only when the dashboard tile context is present", () => {
    assert.match(
      areaSrc,
      /style=\{dashboardTile\s*\?\s*\{\s*cursor:\s*"pointer"\s*\}\s*:\s*undefined\}/,
    );
  });

  it("svg onClick uses localPoint() to source the click position", () => {
    assert.match(areaSrc, /const pt = localPoint\(e\);/);
  });

  it("subtracts MARGIN.left so the click maps to the inner-plot origin used by xPx", () => {
    assert.match(areaSrc, /const clickX = pt\.x - MARGIN\.left;/);
  });

  it("clamps the click to [0, innerWidth] before the nearest-x lookup", () => {
    assert.match(areaSrc, /if \(clickX < 0 \|\| clickX > innerWidth\) return;/);
  });

  it("nearest-x scans pre-stack `series` (NOT `stacked`) so multi-series stacking doesn't skew the lookup", () => {
    // The y values in `stacked` are cumulative, but the x values are
    // identical to `series[i].points[i].x`. Reading from `series` is
    // safer because it (a) avoids the inner `_original` field on
    // stacked points, (b) is the canonical original-data source.
    assert.match(
      areaSrc,
      /for \(const s of series\) \{[\s\S]*?for \(const p of s\.points\) \{[\s\S]*?const px = xPx\(p\.x\);/,
    );
  });

  it("dispatches CROSS_FILTER_EVENT with { column: xCh.field, value: toFilterValue(nearest.x), sourceTileId }", () => {
    assert.match(
      areaSrc,
      /dispatchCrossFilter\(\{[\s\S]*?column: xCh\.field,[\s\S]*?value: toFilterValue\(nearest\.x\),[\s\S]*?sourceTileId: dashboardTile\.tileId,[\s\S]*?\}\);/,
    );
  });

  it("the dispatch is gated on a non-null nearest (empty series → silent no-op)", () => {
    assert.match(areaSrc, /if \(nearest\) \{[\s\S]*?dispatchCrossFilter/);
  });
});
