/**
 * Wave WI4-wiring-point · source-inspection tests for PointRenderer's
 * 2D box-brush → explain-this-slice wiring.
 *
 * PointRenderer is the only chart kind with TWO independently-
 * continuous axes (scatter has both x and y quantitative); a 1D
 * brush would lose information by treating the entire y-axis spread
 * as in-scope. The wave adds mouse-down / move / up state + a
 * 2D `<rect>` overlay from scratch (no pre-existing brush mechanics
 * — pre-wave only per-point onClick handlers powered WD2 cross-
 * filter + WD3 drill-through, both gated on `colorCh`).
 *
 * Tests pin: explainSlice import shape (BRUSH_MIN_PX,
 * dispatchExplainSlice, isBrushDrag, makeBox2dRegion); React hook
 * imports widen to include useEffect / useRef / useState; 2D brush
 * state ({ x, y } pixel coord pairs, not bare numbers like the 1D
 * brushes); brushExplainRef captures e.altKey at brushDown; data-
 * change reset effect; in-plot bounds guard at brushDown; click-vs-
 * drag threshold gated on BOTH axes crossing BRUSH_MIN_PX (a 1D
 * sliver is still a click); xScale.invert / yScale.invert for
 * pixel-to-data; dispatch payload (5 fields); ref + state reset
 * across all paths; per-point tooltip suppressed during active
 * brush; brush rect overlay; cursor crosshair during active brush;
 * NEGATIVE pins against the three 1D region constructors (scatter
 * is box2d-only); NEGATIVE pin against setZoomRange (scatter must
 * not acquire brush-to-zoom by accident); pre-existing WD2 / WD3
 * per-point click handlers preserved byte-identical.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const pointSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/PointRenderer.tsx"),
  "utf-8",
);

describe("WI4-wiring-point · explainSlice imports", () => {
  it("imports the four WI4-foundation helpers from explainSlice (BRUSH_MIN_PX, dispatchExplainSlice, isBrushDrag, makeBox2dRegion)", () => {
    // Foundation module is the single source of truth for the
    // click-vs-drag threshold + region constructor. Importing
    // BRUSH_MIN_PX (instead of redeclaring 6 inline) locks the
    // threshold to the same value the foundation pins.
    assert.match(
      pointSrc,
      /import\s*\{\s*[\s\S]*?BRUSH_MIN_PX[\s\S]*?dispatchExplainSlice[\s\S]*?isBrushDrag[\s\S]*?makeBox2dRegion[\s\S]*?\}\s*from\s*["']@\/pages\/Dashboard\/lib\/explainSlice["']/,
    );
  });

  it("preserves the WD3-wiring-rest-point imports alongside the new WI4 imports", () => {
    // The two wiring waves co-exist on the same renderer — drill
    // through fires on the per-point cmd-click path, explain-slice
    // on the SVG-level brush path. Both import blocks must remain.
    assert.match(
      pointSrc,
      /import\s*\{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\}\s*from\s*["']@\/pages\/Dashboard\/lib\/drillThrough["']/,
    );
  });

  it("does NOT import the three 1D region constructors (scatter is box2d-only — negative pin)", () => {
    // Scatter brushes are 2D rectangles, not 1D ranges. Importing
    // makeNumericRegion / makeTemporalRegion / makeCategoricalRegion
    // would signal a future refactor that downgrades the brush to
    // 1D, defeating the point of WI4-foundation-box2d.
    assert.doesNotMatch(pointSrc, /makeNumericRegion/);
    assert.doesNotMatch(pointSrc, /makeTemporalRegion/);
    assert.doesNotMatch(pointSrc, /makeCategoricalRegion/);
  });

  it("widens the react import to include useEffect / useRef / useState (was useMemo / useRef pre-wave)", () => {
    // The 2D brush state + ref + data-reset effect require three
    // new hooks. Pin the import shape so a future cleanup doesn't
    // drop any of them and silently break the brush.
    assert.match(
      pointSrc,
      /import\s*\{\s*useEffect\s*,\s*useMemo\s*,\s*useRef\s*,\s*useState\s*\}\s*from\s*["']react["']/,
    );
  });
});

describe("WI4-wiring-point · 2D brush state declarations", () => {
  it("declares brushStart as useState<{ x: number; y: number } | null>(null)", () => {
    // Both axes' pixel coords — distinct from the 1D brushes in
    // Line / Area / Bar whose brushStart is a bare number. Null
    // when no brush is active. The shape carries `x` AND `y`
    // because scatter brushes are 2D rectangles.
    assert.match(
      pointSrc,
      /const\s+\[\s*brushStart\s*,\s*setBrushStart\s*\]\s*=\s*useState<\s*\{\s*x:\s*number\s*;\s*y:\s*number\s*\}\s*\|\s*null\s*>\(\s*null\s*\)/,
    );
  });

  it("declares brushEnd as useState<{ x: number; y: number } | null>(null)", () => {
    // Updated by onBrushMove during a held drag — same 2D shape
    // as brushStart so the rect overlay's anchor + extent compute
    // cleanly via Math.min / Math.abs on both axes.
    assert.match(
      pointSrc,
      /const\s+\[\s*brushEnd\s*,\s*setBrushEnd\s*\]\s*=\s*useState<\s*\{\s*x:\s*number\s*;\s*y:\s*number\s*\}\s*\|\s*null\s*>\(\s*null\s*\)/,
    );
  });

  it("declares brushExplainRef as useRef<boolean>(false)", () => {
    // Ref (not state) because the alt flag doesn't drive a re-
    // render. Mirrors the 1D brush wirings (LineRenderer / Area /
    // Bar) shape. Captured at brushDown, consumed at brushUp.
    assert.match(
      pointSrc,
      /const\s+brushExplainRef\s*=\s*useRef<boolean>\(\s*false\s*\)/,
    );
  });

  it("comments the brush state with the WI4-wiring-point wave marker", () => {
    // Wave-attribution comment so future-Claude can grep for the
    // origin wave. Anchored on brushStart so the marker is co-
    // located with the state it introduces.
    assert.match(
      pointSrc,
      /\/\/\s*Wave\s*WI4-wiring-point\s*·[\s\S]{0,800}?const\s+\[\s*brushStart/,
    );
  });
});

describe("WI4-wiring-point · data-change reset effect", () => {
  it("clears brushStart and brushEnd on a useEffect keyed on [data]", () => {
    // Stale brush coords on stale data would render a misleading
    // overlay — the reset on data change is the same pattern Area /
    // Line / Bar use.
    assert.match(
      pointSrc,
      /useEffect\(\s*\(\)\s*=>\s*\{\s*setBrushStart\(null\)\s*;\s*setBrushEnd\(null\)\s*;\s*\}\s*,\s*\[\s*data\s*\]\s*\)/,
    );
  });
});

describe("WI4-wiring-point · onBrushDown — 2D capture + alt flag", () => {
  it("stashes `e.altKey === true` into brushExplainRef.current inside onBrushDown", () => {
    // Strict equality to literal `true` (NOT `!!e.altKey`) so an
    // undefined / missing altKey reliably yields false. Same shape
    // as the 1D brush wirings.
    assert.match(
      pointSrc,
      /brushExplainRef\.current\s*=\s*e\.altKey\s*===\s*true\s*;/,
    );
  });

  it("sets brushStart AND brushEnd to {x, y} from localPoint - MARGIN inside onBrushDown", () => {
    // Both refs initialised to the same coord pair at brushDown —
    // onBrushMove later widens brushEnd as the cursor drags. The
    // subtraction by MARGIN.left / MARGIN.top converts from svg
    // coords to inner-plot coords.
    const downIdx = pointSrc.indexOf("const onBrushDown =");
    assert.ok(downIdx > 0, "onBrushDown declared");
    const slice = pointSrc.slice(downIdx, downIdx + 700);
    assert.match(slice, /const\s+x\s*=\s*pt\.x\s*-\s*MARGIN\.left\s*;/);
    assert.match(slice, /const\s+y\s*=\s*pt\.y\s*-\s*MARGIN\.top\s*;/);
    assert.match(slice, /setBrushStart\(\s*\{\s*x\s*,\s*y\s*\}\s*\)\s*;/);
    assert.match(slice, /setBrushEnd\(\s*\{\s*x\s*,\s*y\s*\}\s*\)\s*;/);
  });

  it("guards brushDown against clicks outside BOTH the x AND y inner-plot bounds", () => {
    // Defensive: a click on the y-axis label region (x < 0) or in
    // the right margin (x > innerWidth) or below the axis (y >
    // innerHeight) doesn't start a brush. Both axes need their
    // own guard for the 2D case.
    const downIdx = pointSrc.indexOf("const onBrushDown =");
    const slice = pointSrc.slice(downIdx, downIdx + 700);
    assert.match(slice, /if\s*\(\s*x\s*<\s*0\s*\|\|\s*x\s*>\s*innerWidth\s*\)\s*return\s*;/);
    assert.match(slice, /if\s*\(\s*y\s*<\s*0\s*\|\|\s*y\s*>\s*innerHeight\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-point · onBrushMove — 2D drag update", () => {
  it("updates brushEnd only when a mouse button is held (gated on `e.buttons & 1`)", () => {
    // Without the button-held guard, plain mouse-move (hover) would
    // continuously update brushEnd and re-render the rect. Same
    // guard shape Area / Bar use.
    const moveIdx = pointSrc.indexOf("const onBrushMove =");
    assert.ok(moveIdx > 0, "onBrushMove declared");
    const slice = pointSrc.slice(moveIdx, moveIdx + 700);
    assert.match(slice, /if\s*\(\s*!\s*\(\s*e\.buttons\s*&\s*1\s*\)\s*\)\s*return\s*;/);
  });

  it("clamps brushEnd to [0, innerWidth] on x AND [0, innerHeight] on y", () => {
    // Math.max(0, Math.min(...)) on both axes — a drag past any
    // edge anchors the rect at the boundary. Same shape as the 1D
    // brushes' clamp but applied independently per axis.
    const moveIdx = pointSrc.indexOf("const onBrushMove =");
    const slice = pointSrc.slice(moveIdx, moveIdx + 700);
    assert.match(
      slice,
      /const\s+x\s*=\s*Math\.max\(\s*0\s*,\s*Math\.min\(\s*innerWidth\s*,\s*pt\.x\s*-\s*MARGIN\.left\s*\)\s*\)/,
    );
    assert.match(
      slice,
      /const\s+y\s*=\s*Math\.max\(\s*0\s*,\s*Math\.min\(\s*innerHeight\s*,\s*pt\.y\s*-\s*MARGIN\.top\s*\)\s*\)/,
    );
  });

  it("short-circuits when brushStart is null (no active brush)", () => {
    // Without this guard, a hover that happens to fire mouseMove
    // before any mouseDown would set brushEnd against a null
    // brushStart. Same shape as the 1D brushes.
    const moveIdx = pointSrc.indexOf("const onBrushMove =");
    const slice = pointSrc.slice(moveIdx, moveIdx + 400);
    assert.match(slice, /if\s*\(\s*brushStart\s*===\s*null\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-point · click-vs-drag threshold — BOTH axes must cross", () => {
  it("uses isBrushDrag on BOTH brushStart.x/brushEnd.x AND brushStart.y/brushEnd.y", () => {
    // A 100×3 sliver (wide x but tiny y) is still a click in the
    // y-dimension; a 3×100 sliver (tall y but tiny x) is a click in
    // the x-dimension. Both axes must cross BRUSH_MIN_PX for a 2D
    // rectangle to count as a drag. This is the box-2D analogue of
    // the 1D brushes' isBrushDrag(start, end, BRUSH_MIN_PX) gate.
    assert.match(
      pointSrc,
      /isBrushDrag\(\s*brushStart\.x\s*,\s*brushEnd\.x\s*,\s*BRUSH_MIN_PX\s*\)\s*&&\s*isBrushDrag\(\s*brushStart\.y\s*,\s*brushEnd\.y\s*,\s*BRUSH_MIN_PX\s*\)/,
    );
  });

  it("does NOT inline a `< 6` literal threshold (negative pin against drift)", () => {
    // The threshold lives in the foundation. If a future refactor
    // re-introduces an inline `< 6`, the foundation's pin would
    // silently desync. Negative pin catches that.
    assert.doesNotMatch(pointSrc, /Math\.abs\([^)]*\)\s*<\s*6/);
  });
});

describe("WI4-wiring-point · explain-slice branch — pixel-to-data inversion + box2d construction", () => {
  it("gates the explain dispatch on `brushExplainRef.current && dashboardTile`", () => {
    // AND-gated on dashboardTile because outside a dashboard the
    // panel has no receiver — same gating shape as the 1D brushes'
    // WI4 wirings.
    assert.match(
      pointSrc,
      /if\s*\(\s*brushExplainRef\.current\s*&&\s*dashboardTile\s*\)/,
    );
  });

  it("inverts pixel coords to data space via xScale.invert AND yScale.invert", () => {
    // The brush captures pixel coords; the box2d region carries
    // data-space bounds. The scale's invert method is the canonical
    // pixel-to-data mapping. yScale's range is [innerHeight, 0]
    // (inverted) so its invert maps low-pixel-y → high-data-y —
    // the constructor normalises so xMin/yMin/xMax/yMax come out
    // correctly regardless of drag direction.
    assert.match(
      pointSrc,
      /const\s+x1Data\s*=\s*xScale\.invert\(\s*brushStart\.x\s*\)/,
    );
    assert.match(
      pointSrc,
      /const\s+x2Data\s*=\s*xScale\.invert\(\s*brushEnd\.x\s*\)/,
    );
    assert.match(
      pointSrc,
      /const\s+y1Data\s*=\s*yScale\.invert\(\s*brushStart\.y\s*\)/,
    );
    assert.match(
      pointSrc,
      /const\s+y2Data\s*=\s*yScale\.invert\(\s*brushEnd\.y\s*\)/,
    );
  });

  it("builds the box2d region via `makeBox2dRegion(x1Data, x2Data, y1Data, y2Data, yCh.field)`", () => {
    // The 5-arg constructor enforces xMin <= xMax + yMin <= yMax
    // normalisation + rejects zero-area / non-finite inputs. The
    // y-column is `yCh.field` (the y-axis encoding's field name) —
    // rides on the region itself so the dispatch event's `column`
    // stays the x-axis column.
    assert.match(
      pointSrc,
      /makeBox2dRegion\(\s*x1Data\s*,\s*x2Data\s*,\s*y1Data\s*,\s*y2Data\s*,\s*yCh\.field\s*,?\s*\)/,
    );
  });

  it("only dispatches when the constructor returns a non-null region (defensive)", () => {
    // makeBox2dRegion returns null for zero-area / non-finite —
    // the dispatch is guarded so a malformed event never fires.
    assert.match(
      pointSrc,
      /if\s*\(\s*region\s*\)\s*\{\s*\n\s*dispatchExplainSlice/,
    );
  });
});

describe("WI4-wiring-point · dispatch payload shape", () => {
  it("dispatches with chartId / column / region / sourceTileId / filters (5 fields)", () => {
    // Field-by-field pin so a future widening is an explicit edit,
    // not a silent drift. Same shape as the 1D brushes' WI4
    // dispatches. `column = xCh.field` is the x-axis column;
    // the y-column rides on the region's `yColumn` field
    // (constructed in the WI4-foundation-box2d wave).
    const dispatchIdx = pointSrc.indexOf("dispatchExplainSlice({");
    assert.ok(dispatchIdx > 0, "dispatchExplainSlice call present");
    const slice = pointSrc.slice(dispatchIdx, dispatchIdx + 700);
    assert.match(slice, /chartId:\s*dashboardTile\.tileId/);
    assert.match(slice, /column:\s*xCh\.field/);
    assert.match(slice, /region,/);
    assert.match(slice, /sourceTileId:\s*dashboardTile\.tileId/);
    assert.match(slice, /filters:\s*dashboardFilters/);
  });
});

describe("WI4-wiring-point · ref + state cleanup across all brushUp paths", () => {
  it("resets brushExplainRef.current = false and clears brush state after the click-path return", () => {
    // The click path (drag below threshold on either axis) yields
    // to the per-point onClick (if the cursor was on a point). The
    // brush state must be cleared before the return so the next
    // brushDown starts fresh.
    const clickPathIdx = pointSrc.indexOf("if (!isDrag)");
    assert.ok(clickPathIdx > 0, "click path branch present");
    const clickPathSlice = pointSrc.slice(clickPathIdx, clickPathIdx + 400);
    assert.match(clickPathSlice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(clickPathSlice, /setBrushStart\(null\)\s*;/);
    assert.match(clickPathSlice, /setBrushEnd\(null\)\s*;/);
    assert.match(clickPathSlice, /return\s*;/);
  });

  it("resets brushExplainRef.current = false and clears brush state after the explain-slice dispatch", () => {
    // The explain path resets the ref and state so a subsequent
    // plain drag's brushDown overwrites them cleanly. Reset lives
    // BELOW the dispatch (not inside the gated block) so a non-
    // dispatch drag (e.g. non-alt) also clears state.
    const dispatchIdx = pointSrc.indexOf("dispatchExplainSlice({");
    const slice = pointSrc.slice(dispatchIdx, dispatchIdx + 1000);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
  });
});

describe("WI4-wiring-point · NO brush-to-zoom (negative pin)", () => {
  it("does NOT introduce setZoomRange in PointRenderer (deliberate scope decision)", () => {
    // Scatter charts don't have a natural "zoom-to-brushed-range"
    // semantic — zooming would require recomputing both xScale and
    // yScale domains independently and would conflict with the
    // explain-slice intent (the brush IS the slice, not a zoom
    // target). Keeping the brush exclusively for explain-slice
    // avoids the plain-drag-vs-alt-drag disambiguation complexity
    // LineRenderer has.
    assert.doesNotMatch(pointSrc, /setZoomRange/);
  });

  it("does NOT declare a zoomRange state (would imply zoom support)", () => {
    // Stronger negative pin — even unused, a zoomRange state would
    // signal an in-progress brush-to-zoom that future readers
    // shouldn't assume exists.
    assert.doesNotMatch(pointSrc, /useState<\[number\s*,\s*number\]/);
  });
});

describe("WI4-wiring-point · SVG handler attachment", () => {
  it("attaches onMouseDown, onMouseMove, onMouseUp to the svg (gated on dashboardTile)", () => {
    // Brush handlers gated on dashboardTile because outside a
    // dashboard the brush has no receiver. Inside a dashboard, the
    // three handlers power the alt-drag → explain pipeline.
    assert.match(
      pointSrc,
      /onMouseDown=\{\s*dashboardTile\s*\?\s*onBrushDown\s*:\s*undefined\s*\}/,
    );
    assert.match(
      pointSrc,
      /onMouseMove=\{\s*dashboardTile\s*\?\s*onBrushMove\s*:\s*undefined\s*\}/,
    );
    assert.match(
      pointSrc,
      /onMouseUp=\{\s*dashboardTile\s*\?\s*onBrushUp\s*:\s*undefined\s*\}/,
    );
  });

  it("attaches onSvgMouseLeave that clears in-flight brush state AND hides the tooltip", () => {
    // The pre-wave shape was `onMouseLeave={hideTooltip}` — the
    // function-reference form is replaced with a named handler
    // that does BOTH hideTooltip() AND a brush state clear if
    // active. Safety net for cursor-leaves-svg-mid-drag (the next
    // mouseUp fires outside the svg and would never reach onBrushUp).
    assert.match(pointSrc, /const\s+onSvgMouseLeave\s*=\s*\(\)\s*=>\s*\{/);
    assert.match(pointSrc, /onMouseLeave=\{\s*onSvgMouseLeave\s*\}/);
    const leaveIdx = pointSrc.indexOf("const onSvgMouseLeave");
    assert.ok(leaveIdx > 0, "onSvgMouseLeave declared");
    const slice = pointSrc.slice(leaveIdx, leaveIdx + 500);
    assert.match(slice, /hideTooltip\(\)/);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*\)/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
  });

  it("toggles svg cursor to crosshair during an active brush", () => {
    // crosshair is the canonical 2D-rect-selection affordance —
    // distinct from the 1D brushes' ew-resize / ns-resize. The
    // per-point cursor: pointer style overrides this on the
    // points themselves; the svg-level crosshair shows through on
    // the gridlines / empty plot area.
    assert.match(
      pointSrc,
      /brushStart\s*!==\s*null\s*\n?\s*\?\s*\{\s*cursor:\s*["']crosshair["']\s*\}/,
    );
  });
});

describe("WI4-wiring-point · 2D brush rect overlay", () => {
  it("renders a `<rect>` overlay only when both brushStart and brushEnd are non-null", () => {
    // Conditional render — no overlay when no brush is active.
    // `!== null` (not truthy) because brushStart could be {x: 0,
    // y: 0} (valid at left-bottom corner of inner plot).
    assert.match(
      pointSrc,
      /\{\s*brushStart\s*!==\s*null\s*&&\s*brushEnd\s*!==\s*null\s*&&\s*\(\s*\n\s*<rect/,
    );
  });

  it("anchors the rect at (Math.min(brushStart.x, brushEnd.x), Math.min(brushStart.y, brushEnd.y)) for reverse drags", () => {
    // A drag from lower-right to upper-left has brushStart.x >
    // brushEnd.x AND brushStart.y > brushEnd.y. The rect anchors
    // at the lesser of each pair so reverse drags render correctly.
    assert.match(
      pointSrc,
      /x=\{\s*Math\.min\(\s*brushStart\.x\s*,\s*brushEnd\.x\s*\)\s*\}/,
    );
    assert.match(
      pointSrc,
      /y=\{\s*Math\.min\(\s*brushStart\.y\s*,\s*brushEnd\.y\s*\)\s*\}/,
    );
  });

  it("sizes the rect by Math.abs on both axes", () => {
    // width / height = absolute diff on each axis so reverse drags
    // produce the correct extents.
    assert.match(
      pointSrc,
      /width=\{\s*Math\.abs\(\s*brushEnd\.x\s*-\s*brushStart\.x\s*\)\s*\}/,
    );
    assert.match(
      pointSrc,
      /height=\{\s*Math\.abs\(\s*brushEnd\.y\s*-\s*brushStart\.y\s*\)\s*\}/,
    );
  });

  it("sets pointerEvents=\"none\" so the overlay never intercepts mouse events", () => {
    // Without pointerEvents="none", the rect would absorb mouseUp /
    // mouseMove events during the latter half of a drag, breaking
    // the drag. Also load-bearing for per-point click pass-through:
    // a cmd-click on a point UNDER the overlay must still reach
    // the point's onClick (WD3 drill-through).
    const rectIdx = pointSrc.indexOf("<rect\n");
    assert.ok(rectIdx > 0, "<rect JSX element present");
    const slice = pointSrc.slice(rectIdx, rectIdx + 700);
    assert.match(slice, /pointerEvents=["']none["']/);
  });

  it("uses the same primary-tint dashed-stroke styling as the 1D brushes", () => {
    // Visual consistency across all four brush-capable kinds —
    // primary at 0.1 fill + 0.4 stroke + dashed `3 3`. Same shape
    // Line / Area / Bar use.
    const rectIdx = pointSrc.indexOf("<rect\n");
    const slice = pointSrc.slice(rectIdx, rectIdx + 700);
    assert.match(slice, /fill=["']hsl\(var\(--primary\)\)["']/);
    assert.match(slice, /fillOpacity=\{\s*0\.1\s*\}/);
    assert.match(slice, /stroke=["']hsl\(var\(--primary\)\)["']/);
    assert.match(slice, /strokeOpacity=\{\s*0\.4\s*\}/);
    assert.match(slice, /strokeDasharray=["']3 3["']/);
  });
});

describe("WI4-wiring-point · per-point tooltip suppressed during brush", () => {
  it("guards onPointMove with `if (brushStart !== null) return;` at the top", () => {
    // Per-point onMouseMove fires on every pixel a point is hovered;
    // during a brush drag the cursor passes over many points and
    // the tooltip would flicker. The guard short-circuits the
    // tooltip update when a brush is in flight. Same guard shape
    // BarRenderer's onMouseMove uses.
    const onPointMoveIdx = pointSrc.indexOf("const onPointMove =");
    assert.ok(onPointMoveIdx > 0, "onPointMove declared");
    const slice = pointSrc.slice(onPointMoveIdx, onPointMoveIdx + 400);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-point · pre-existing per-point click handlers preserved", () => {
  it("keeps the WD3 drill-through dispatch on the cmd/ctrl click path", () => {
    // WD3 wiring stays intact — the brush (SVG-level) and per-
    // point click (point-level) handle different event paths and
    // never conflict. Negative pin would catch an accidental
    // removal.
    assert.match(
      pointSrc,
      /if\s*\(\s*isModifierClick\(\s*e\s*\)\s*\)\s*\{\s*\n\s*dispatchDrillThrough\(\{/,
    );
  });

  it("keeps the WD2 cross-filter dispatch on the plain click path", () => {
    // WD2 cross-filter on plain click is the default click intent
    // (cmd-click drills, alt-drag explains, plain click filters).
    assert.match(
      pointSrc,
      /dispatchCrossFilter\(\{\s*column:\s*colorCh!\.field/,
    );
  });
});

describe("WI4-wiring-point · wave marker present", () => {
  it("includes the WI4-wiring-point wave marker in the file (greppable lineage)", () => {
    // The marker lets future-Claude grep for the wave's wiring
    // surface; mirrors the WI4-wiring-trend / area / bar marker
    // shape.
    assert.match(pointSrc, /Wave\s*WI4-wiring-point/);
  });
});
