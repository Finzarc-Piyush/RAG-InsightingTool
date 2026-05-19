/**
 * Wave WD3-wiring-bar · source-inspection tests for
 * [BarRenderer.tsx](../../../lib/charts/visxRenderers/BarRenderer.tsx)'s
 * cmd / ctrl-click drill-through branch.
 *
 * The renderer's existing `onClick` (which dispatches
 * `dispatchCrossFilter({...})` on a plain click inside a dashboard
 * tile) gains a top-of-handler modifier-key branch: when
 * `isModifierClick(event)` is truthy AND the renderer is wrapped in a
 * `DashboardTileProvider`, the handler dispatches `dispatchDrillThrough({...})`
 * instead and returns — short-circuiting the cross-filter path. The
 * chat / explorer `grid.inGrid` branch keeps its existing plain-click
 * contract (drill-through is a dashboard-only feature; chat / explorer
 * have no per-chart drill endpoint).
 *
 * Tests pin: the import shape (named imports from the
 * drillThrough helper module); the event-parameter typing on the
 * onClick handler (`React.MouseEvent<SVGElement>`); the branch order
 * (modifier branch FIRST so it short-circuits before either of the
 * pre-existing filter paths); the dispatch shape (chartId from
 * `dashboardTile.tileId`, column from `enc.x.field`, value from
 * `c.outerRaw` raw NOT `toFilterValue(c.outerRaw)`, sourceTileId from
 * `dashboardTile.tileId`, filters from `dashboardFilters`); the
 * `return;` after the dispatch (so the cross-filter dispatch doesn't
 * also fire on the same click); the dashboardTile gate on the modifier
 * branch (chat / explorer modifier-clicks fall through to the
 * grid.inGrid path).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const src = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BarRenderer.tsx"),
  "utf-8",
);

describe("WD3-wiring-bar · BarRenderer imports the drillThrough helpers", () => {
  it("named-imports isModifierClick + dispatchDrillThrough from @/pages/Dashboard/lib/drillThrough", () => {
    // Both helpers live in the new drillThrough module (not in
    // crossFilter — the two intents stay in separate modules even
    // though they share helper shape, so future Claude can see the
    // dispatch surfaces side-by-side at the import block).
    assert.match(
      src,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("keeps the WD2 crossFilter imports untouched (additive change, no breakage)", () => {
    // Pin that the existing dispatchCrossFilter + isCrossFilterActive
    // + toFilterValue imports are unchanged. The WD3 wiring is purely
    // additive — a renderer that loses the crossFilter imports would
    // regress every WD2 family contract on this file.
    assert.match(
      src,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

describe("WD3-wiring-bar · BarRenderer onClick gains the modifier-key drill-through branch", () => {
  it("accepts the event parameter on the onClick arrow (typed React.MouseEvent<SVGElement>)", () => {
    // Pre-wave the onClick was a parameterless arrow `() => {...}`.
    // The modifier check needs the event so the arrow signature
    // widens to `(event: React.MouseEvent<SVGElement>) =>`. Pin the
    // exact typing so a refactor that drops `React.MouseEvent` in
    // favour of a generic `any` event would break loudly.
    assert.match(
      src,
      /onClick=\{\s*interactive\s*\?\s*\(event: React\.MouseEvent<SVGElement>\) =>/,
    );
  });

  it("modifier branch fires FIRST (before grid.inGrid and dispatchCrossFilter paths) so it short-circuits cleanly", () => {
    // The branch order is load-bearing. If grid.inGrid or
    // dispatchCrossFilter ran before the modifier check, a cmd-click
    // would both filter AND drill-through, doubling the user's
    // intent. Pin the order via a single regex that spans the
    // handler body.
    assert.match(
      src,
      /\(event: React\.MouseEvent<SVGElement>\) => \{[\s\S]*?if \(dashboardTile && isModifierClick\(event\)\) \{[\s\S]*?dispatchDrillThrough\([\s\S]*?\}[\s\S]*?if \(grid\.inGrid\)[\s\S]*?if \(dashboardTile\) \{[\s\S]*?dispatchCrossFilter\(/,
    );
  });

  it("modifier branch is gated on `dashboardTile && isModifierClick(event)` — drill-through is dashboard-only", () => {
    // Chat / explorer charts (no dashboardTile context) don't have
    // a drill-through endpoint. A modifier-click on a chat chart
    // falls through to the grid.inGrid path so the user still gets
    // the plain-click filter behaviour they expect. Pin the AND-gate
    // so a future widening to chat doesn't sneak in unannounced.
    assert.match(
      src,
      /if \(dashboardTile && isModifierClick\(event\)\) \{/,
    );
  });

  it("dispatchDrillThrough payload carries the right 5 fields (chartId, column, value, sourceTileId, filters)", () => {
    // The chartId on a dashboard tile is the tile id (the dashboard's
    // chart-by-position identifier — `chart-0`, `chart-1`, …). Server
    // endpoints already use that lookup convention (see XLSX export).
    // The value passes `c.outerRaw` DIRECTLY (NOT
    // `toFilterValue(c.outerRaw)`) — drill-through value coercion is
    // the server's job; passing the type-original raw lets the
    // server's canonicaliser pick the right comparison (Date,
    // number, etc.). The filters snapshot threads
    // `dashboardFilters` (already lifted at the top of the renderer
    // for the WD2-dim concern) so the server applies the dashboard-
    // wide filter context BEFORE pinning (column, value).
    assert.match(
      src,
      /dispatchDrillThrough\(\{\s*chartId: dashboardTile\.tileId,\s*column: enc\.x\.field,\s*value: c\.outerRaw,\s*sourceTileId: dashboardTile\.tileId,\s*filters: dashboardFilters,?\s*\}\);/,
    );
  });

  it("the modifier branch returns after dispatching (so cross-filter doesn't also fire on the same click)", () => {
    // Without the early `return;`, a cmd-click would dispatch BOTH
    // the drill-through event AND the cross-filter event. The two
    // intents are mutually exclusive — pin the return.
    assert.match(
      src,
      /dispatchDrillThrough\(\{[\s\S]*?\}\);\s*return;/,
    );
  });

  it("value is passed RAW (c.outerRaw) — NOT coerced via toFilterValue", () => {
    // Drill-through coercion happens server-side (the value may be
    // a Date / number / categorical string and the server's row
    // lookup applies the right comparison per column type). Passing
    // toFilterValue(c.outerRaw) here would lossy-stringify before
    // the server saw it. Negative pin against a future refactor that
    // tries to "normalise" the value at dispatch time.
    const drillBlock = src.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "must find the dispatchDrillThrough call");
    assert.doesNotMatch(drillBlock, /value: toFilterValue\(/);
  });

  it("plain-click (no modifier) still dispatches cross-filter on a dashboard tile (WD2 contract preserved)", () => {
    // The existing WD2-wiring-bar dispatch path is untouched: when
    // the modifier branch falls through, the dashboardTile gate
    // runs `dispatchCrossFilter({...})` with the pre-wave shape
    // (toFilterValue-coerced value).
    assert.match(
      src,
      /if \(dashboardTile\) \{\s*dispatchCrossFilter\(\{\s*column: enc\.x\.field,\s*value: toFilterValue\(c\.outerRaw\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);\s*\}/,
    );
  });

  it("plain-click chat / explorer (grid.inGrid) keeps its toggleFilter call (pre-wave contract preserved)", () => {
    // Pin the chat / explorer filter behaviour. A modifier-click in
    // chat / explorer (no dashboardTile) falls through the
    // modifier gate AND through `if (dashboardTile)`, landing on the
    // grid.inGrid path. The grid filter contract is unaffected by
    // WD3.
    assert.match(
      src,
      /if \(grid\.inGrid\) \{\s*grid\.toggleFilter\(\{\s*field: enc\.x\.field,\s*value: c\.outerRaw,?\s*\}\);\s*\}/,
    );
  });
});

describe("WD3-wiring-bar · cross-cutting contracts", () => {
  it("carries the WD3-wiring-bar marker for future grep-ability", () => {
    // Single marker lets a future Claude find every WD3-wiring-bar
    // site via `grep -rn WD3-wiring-bar`. Same convention as the
    // WD2-* markers.
    assert.match(src, /WD3-wiring-bar/);
  });

  it("dim / dispatch / drill share the same dispatch column (enc.x.field) — pin the symmetry", () => {
    // The three concerns (WD2-dim, WD2-wiring, WD3-wiring) all
    // operate on the same column for BarRenderer. A drift here
    // (e.g. drill on `enc.color.field`) would produce a
    // "click-to-drill on a column you can't click-to-filter" UX
    // mismatch.
    const dimCall = src.match(
      /isCrossFilterActive\(\s*dashboardFilters!,\s*enc\.x\.field,/,
    );
    const dispatchCall = src.match(
      /dispatchCrossFilter\(\{\s*column: enc\.x\.field,/,
    );
    const drillCall = src.match(
      /dispatchDrillThrough\(\{[\s\S]*?column: enc\.x\.field,/,
    );
    assert.ok(dimCall, "dim must call isCrossFilterActive on enc.x.field");
    assert.ok(
      dispatchCall,
      "dispatch must use enc.x.field as the cross-filter column",
    );
    assert.ok(drillCall, "drill must use enc.x.field as the column");
  });
});
