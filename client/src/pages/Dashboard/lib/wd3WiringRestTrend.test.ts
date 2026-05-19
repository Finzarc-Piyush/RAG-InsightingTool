/**
 * Wave WD3-wiring-rest-trend · source-inspection tests for the trend
 * visx renderers (Line + Area). Both fan out the WD3 modifier-key
 * intent on top of the existing WD2-wiring nearest-x lookup, but the
 * two renderers differ in WHERE the click event lives:
 *
 *   - **AreaRenderer**'s nearest-x lookup runs inside a top-level
 *     `onClick={(e: React.MouseEvent<SVGElement>) => {...}}` that
 *     already receives the event — the WD3 wiring is an inline
 *     `if (isModifierClick(e)) { dispatchDrillThrough({...}); return; }`
 *     branch right before the existing dispatchCrossFilter call.
 *     Same single-event-handler shape as the WD3-wiring-rest-cat
 *     family.
 *   - **LineRenderer**'s dispatchCrossFilter fires inside the
 *     parameterless `onBrushUp` handler (the brush-zoom plumbing
 *     piggybacks the click semantic: a tiny < 6 px brush is treated
 *     as a click). The brushUp handler has no access to the original
 *     MouseEvent. The wave's design choice: stash the modifier flag
 *     in a `brushModifierRef = useRef<boolean>(false)` at
 *     `onBrushDown` time, then read it in `onBrushUp`. Ref (not
 *     state) because the flag doesn't drive a re-render — only the
 *     brush rectangle does.
 *
 * Tests pin: import shape; AreaRenderer's inline branch + payload;
 * LineRenderer's brushModifierRef declaration + capture-on-brushDown
 * + consume-on-brushUp + reset-after-dispatch; per-renderer drill
 * value passed RAW (NOT toFilterValue-coerced); cross-cutting
 * column-symmetry pin (drill + cross-filter + dim all on xCh.field
 * for each renderer); WD3-wiring-rest-trend marker present.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const areaSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/AreaRenderer.tsx"),
  "utf-8",
);
const lineSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/LineRenderer.tsx"),
  "utf-8",
);

// ── AreaRenderer ────────────────────────────────────────────────────

describe("WD3-wiring-rest-trend · AreaRenderer imports the drillThrough helpers", () => {
  it("named-imports isModifierClick + dispatchDrillThrough from @/pages/Dashboard/lib/drillThrough", () => {
    assert.match(
      areaSrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("keeps the WD2 crossFilter imports untouched (additive change)", () => {
    assert.match(
      areaSrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

describe("WD3-wiring-rest-trend · AreaRenderer onClick gains the inline modifier-key branch", () => {
  it("the modifier branch fires INSIDE the if (nearest) block, BEFORE dispatchCrossFilter", () => {
    // The lookup is already nearest-x (shared with the WD2 path);
    // only the dispatcher diverges. Pin the branch sits inside the
    // `if (nearest) { ... }` body and short-circuits before the
    // dispatchCrossFilter call.
    assert.match(
      areaSrc,
      /if \(nearest\) \{[\s\S]*?if \(isModifierClick\(e\)\) \{[\s\S]*?dispatchDrillThrough\(\{[\s\S]*?\}\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?dispatchCrossFilter\(/,
    );
  });

  it("dispatchDrillThrough payload carries chartId / column / value (raw) / sourceTileId / filters", () => {
    assert.match(
      areaSrc,
      /dispatchDrillThrough\(\{\s*chartId: dashboardTile\.tileId,\s*column: xCh\.field,\s*value: nearest\.x,\s*sourceTileId: dashboardTile\.tileId,\s*filters: dashboardFilters,?\s*\}\);/,
    );
  });

  it("drill value passed RAW — NOT toFilterValue-coerced", () => {
    const drillBlock = areaSrc.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "AreaRenderer must contain a dispatchDrillThrough block");
    assert.doesNotMatch(drillBlock, /value: toFilterValue\(/);
  });

  it("plain-click (no modifier) still dispatches cross-filter with toFilterValue-coerced value (WD2 contract preserved)", () => {
    // Regression-pin: the WD2 dispatch path is untouched. A future
    // refactor that accidentally drops the cross-filter dispatch
    // would break loudly.
    assert.match(
      areaSrc,
      /dispatchCrossFilter\(\{\s*column: xCh\.field,\s*value: toFilterValue\(nearest\.x\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });
});

// ── LineRenderer ────────────────────────────────────────────────────

describe("WD3-wiring-rest-trend · LineRenderer imports the drillThrough helpers", () => {
  it("named-imports isModifierClick + dispatchDrillThrough", () => {
    assert.match(
      lineSrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("keeps the WD2 crossFilter imports untouched", () => {
    assert.match(
      lineSrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

describe("WD3-wiring-rest-trend · LineRenderer declares brushModifierRef", () => {
  it("declares a useRef<boolean> seeded false (NOT useState — re-render not needed)", () => {
    // useRef is the right tool because the modifier flag doesn't
    // need to drive a render — only the brush rectangle does. A
    // refactor that switches to useState would force a re-render on
    // every cmd-down without any visual change.
    assert.match(
      lineSrc,
      /const brushModifierRef = useRef<boolean>\(false\);/,
    );
  });
});

describe("WD3-wiring-rest-trend · LineRenderer captures modifier in onBrushDown", () => {
  it("assigns brushModifierRef.current = isModifierClick(e) inside onBrushDown", () => {
    // The brushDown handler receives the MouseEvent; the brushUp
    // handler doesn't. Capture must happen at brushDown.
    assert.match(
      lineSrc,
      /const onBrushDown = \(e: React\.MouseEvent<SVGElement>\) => \{[\s\S]*?brushModifierRef\.current = isModifierClick\(e\);[\s\S]*?\};/,
    );
  });
});

describe("WD3-wiring-rest-trend · LineRenderer branches on brushModifierRef in onBrushUp", () => {
  it("the tiny-drag click path branches on brushModifierRef.current — drill XOR cross-filter, never both", () => {
    // The branch is an `if (brushModifierRef.current) drill else
    // crossFilter` structure inside the `if (nearest)` block. Pin
    // both branches exist and the drill branch is the FIRST one
    // (cmd → drill; default → filter).
    assert.match(
      lineSrc,
      /if \(nearest\) \{[\s\S]*?if \(brushModifierRef\.current\) \{[\s\S]*?dispatchDrillThrough\([\s\S]*?\} else \{[\s\S]*?dispatchCrossFilter\(/,
    );
  });

  it("dispatchDrillThrough payload carries chartId / column / value (raw nearest.x) / sourceTileId / filters", () => {
    assert.match(
      lineSrc,
      /dispatchDrillThrough\(\{\s*chartId: dashboardTile\.tileId,\s*column: xCh\.field,\s*value: nearest\.x,\s*sourceTileId: dashboardTile\.tileId,\s*filters: dashboardFilters,?\s*\}\);/,
    );
  });

  it("drill value passed RAW (nearest.x) — NOT toFilterValue-coerced", () => {
    const drillBlock = lineSrc.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "LineRenderer must contain a dispatchDrillThrough block");
    assert.doesNotMatch(drillBlock, /value: toFilterValue\(/);
  });

  it("brushModifierRef.current resets to false after the dispatch (before brushStart/brushEnd setState)", () => {
    // Without the reset, a stale `true` flag would persist past the
    // wave's tiny-drag click. The reset must happen on EVERY brushUp
    // exit (whether or not the dispatch fired), so a brush-zoom
    // mouseup with cmd held doesn't leave the flag dirty.
    assert.match(
      lineSrc,
      /brushModifierRef\.current = false;\s*setBrushStart\(null\);\s*setBrushEnd\(null\);\s*return;/,
    );
  });

  it("plain-click (else branch) still dispatches cross-filter with toFilterValue-coerced value", () => {
    // Regression-pin: the WD2 nearest-x dispatch path is preserved
    // exactly when the modifier flag is false.
    assert.match(
      lineSrc,
      /\} else \{\s*dispatchCrossFilter\(\{\s*column: xCh\.field,\s*value: toFilterValue\(nearest\.x\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);\s*\}/,
    );
  });
});

// ── Cross-cutting contracts ────────────────────────────────────────

describe("WD3-wiring-rest-trend · cross-cutting contracts", () => {
  it("each renderer carries the WD3-wiring-rest-trend marker", () => {
    assert.match(areaSrc, /WD3-wiring-rest-trend/);
    assert.match(lineSrc, /WD3-wiring-rest-trend/);
  });

  it("each renderer's drill column matches its WD2 cross-filter dispatch column (xCh.field)", () => {
    // Column-symmetry across the two concerns. Drift would produce
    // a "drill on a column you can't filter" UX mismatch.
    assert.match(
      areaSrc,
      /dispatchDrillThrough\(\{[\s\S]*?column: xCh\.field,/,
    );
    assert.match(
      areaSrc,
      /dispatchCrossFilter\(\{\s*column: xCh\.field,/,
    );
    assert.match(
      lineSrc,
      /dispatchDrillThrough\(\{[\s\S]*?column: xCh\.field,/,
    );
    assert.match(
      lineSrc,
      /dispatchCrossFilter\(\{\s*column: xCh\.field,/,
    );
  });

  it("each renderer's drill dispatch count is exactly 1 (per-renderer single-shot)", () => {
    // AreaRenderer: one onClick → one drill dispatch. LineRenderer:
    // one brushUp click-fallthrough → one drill dispatch (the brush-
    // zoom path on the same brushUp doesn't drill). Pin the count
    // so a refactor that adds a second dispatch surface (e.g.
    // legend cmd-click) is intentional.
    const areaDrillCount = (areaSrc.match(/dispatchDrillThrough\(/g) ?? []).length;
    const lineDrillCount = (lineSrc.match(/dispatchDrillThrough\(/g) ?? []).length;
    assert.equal(areaDrillCount, 1, `AreaRenderer expected 1 drill dispatch, found ${areaDrillCount}`);
    assert.equal(lineDrillCount, 1, `LineRenderer expected 1 drill dispatch, found ${lineDrillCount}`);
  });
});
