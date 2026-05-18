/**
 * Wave WD2-wiring-rest-rect · source-inspection tests for the
 * RectRenderer (heatmap) cross-filter dispatch.
 *
 * Heatmap cells sit at the intersection of TWO categorical dims
 * (rowCh and colCh). A cell click dispatches TWO CROSS_FILTER_EVENT
 * events in row-first order, one per dim. `applyCrossFilter` is pure
 * and event-driven, so back-to-back dispatches each toggle their own
 * column independently. The user sees the row + col filter applied;
 * clicking the same cell again toggles both back off.
 *
 * Both dims preserve their type-original raw value via a parallel
 * `rowRawByKey` / `colRawByKey` map keyed by the stringified domain
 * label — same shape as ArcRenderer's `{ value, rawKey }` aggregator
 * from the WD2-wiring-rest-cat wave.
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

describe("WD2-wiring-rest-rect · RectRenderer cross-filter wiring", () => {
  it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
    assert.match(
      rectSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
  });

  it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      rectSrc,
      /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("reads the dashboard-tile context once in the renderer body", () => {
    assert.match(rectSrc, /const dashboardTile = useDashboardTileContext\(\);/);
  });

  it("sets cursor:pointer on the cell only when the dashboard tile context is present", () => {
    assert.match(
      rectSrc,
      /style=\{dashboardTile[^?]*\?\s*\{\s*cursor:\s*"pointer"\s*\}\s*:\s*undefined\}/,
    );
  });

  it("dispatches CROSS_FILTER_EVENT for the row dim using rowCh.field + rowRawByKey.get(row)", () => {
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{[\s\S]*?column: rowCh\.field,[\s\S]*?value: toFilterValue\(rowRawByKey\.get\(row\)\),[\s\S]*?sourceTileId: dashboardTile\.tileId,[\s\S]*?\}\);/,
    );
  });

  it("dispatches CROSS_FILTER_EVENT for the col dim using colCh.field + colRawByKey.get(col)", () => {
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{[\s\S]*?column: colCh\.field,[\s\S]*?value: toFilterValue\(colRawByKey\.get\(col\)\),[\s\S]*?sourceTileId: dashboardTile\.tileId,[\s\S]*?\}\);/,
    );
  });

  it("the two dispatches share a single onClick (row dispatch precedes col dispatch)", () => {
    // Pin row-first ordering so toggling behaviour is byte-stable: a
    // re-click on the same cell removes the row filter first, then the
    // col filter. If a future maintainer reorders this, the toggle
    // semantics still hold (both reverse correctly), but pinning the
    // order keeps test debugging deterministic. Search for the inner
    // `column: <field>` anchor directly — `String#search()` returns the
    // start of the OVERALL match, so a regex starting with the outer
    // `dispatchCrossFilter` literal would return the same index for
    // both searches.
    const rowIdx = rectSrc.indexOf("column: rowCh.field");
    const colIdx = rectSrc.indexOf("column: colCh.field");
    assert.notStrictEqual(rowIdx, -1, "row dispatch missing");
    assert.notStrictEqual(colIdx, -1, "col dispatch missing");
    assert.ok(rowIdx < colIdx, `row dispatch should come before col dispatch (row=${rowIdx} col=${colIdx})`);
  });

  it("the dispatch is gated on dashboardTile being non-null", () => {
    assert.match(rectSrc, /dashboardTile\s*\?[\s\S]*?dispatchCrossFilter/);
  });
});

describe("WD2-wiring-rest-rect · raw row/col values are preserved", () => {
  it("rowRawByKey + colRawByKey maps are built alongside the stringified domains", () => {
    assert.match(rectSrc, /const rRaw = new Map<string, unknown>\(\);/);
    assert.match(rectSrc, /const cRaw = new Map<string, unknown>\(\);/);
  });

  it("first row encountered per stringified key sets the raw value (no overwrite)", () => {
    assert.match(rectSrc, /if \(!rRaw\.has\(rk\)\) \{[\s\S]*?rRaw\.set\(rk, rowRaw\);[\s\S]*?rs\.push\(rk\);[\s\S]*?\}/);
    assert.match(rectSrc, /if \(!cRaw\.has\(ck\)\) \{[\s\S]*?cRaw\.set\(ck, colRaw\);[\s\S]*?cs\.push\(ck\);[\s\S]*?\}/);
  });

  it("the row/col domain useMemo returns { rows, rowRawByKey, cols, colRawByKey }", () => {
    assert.match(
      rectSrc,
      /const \{ rows, rowRawByKey, cols, colRawByKey \} = useMemo\(/,
    );
    assert.match(
      rectSrc,
      /return \{ rows: rs, rowRawByKey: rRaw, cols: cs, colRawByKey: cRaw \};/,
    );
  });
});
