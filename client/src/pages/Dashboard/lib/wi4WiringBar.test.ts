/**
 * Wave WI4-wiring-bar · source-inspection tests for BarRenderer's
 * alt-drag → explain-this-slice wiring.
 *
 * BarRenderer had NO pre-existing brush mechanics (only per-bar
 * onClick handlers powering WD2 cross-filter + WD3 drill-through).
 * This wave adds the mouse-down / move / up state + a `<rect>`
 * overlay from scratch (mirroring WI4-wiring-area's shape) so an
 * alt-drag dispatches an `ExplainSliceEvent`. Categorical-only —
 * bars use a band scale on `enc.x.field`, no temporal branch
 * needed. Plain drag is a deliberate no-op (Bar charts have no
 * zoom). Orientation-aware: vertical bars brush horizontally
 * (`ew-resize`); horizontal bars brush vertically (`ns-resize`).
 *
 * Tests pin: explainSlice import shape (4-helper, no
 * makeTemporalRegion); React hook imports (already widened from
 * pre-wave); brushStart/brushEnd useState + brushExplainRef useRef
 * declarations; data-change reset useEffect; orientation-aware
 * `isVertical` / `brushAxisSize` / `brushAxisOffset` derivation;
 * onBrushDown alt + coord capture (orientation-aware) +
 * out-of-bounds guard; onBrushMove buttons-held gate + clamp +
 * brushStart-null short-circuit; onBrushUp threshold via
 * `isBrushDrag(... , BRUSH_MIN_PX)`; explain branch gating + i0/i1
 * derivation from xValues.length + `makeCategoricalRegion(xValues
 * .slice(i0, i1))`; dispatch payload (5 fields, column = enc.x.field);
 * ref + state reset on all paths; NEGATIVE pin against makeTemporal
 * / makeNumeric region (categorical-only) + against setZoomRange
 * (no zoom on Bar); svg handler attachment + orientation-aware
 * cursor toggle; brush rect overlay (orientation-aware shape);
 * per-bar tooltip suppression during active brush; pre-existing
 * WD2 + WD3 per-bar onClick handlers preserved; wave marker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const barSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BarRenderer.tsx"),
  "utf-8",
);

describe("WI4-wiring-bar · explainSlice imports", () => {
  it("imports the four WI4-foundation helpers from explainSlice (BRUSH_MIN_PX, dispatchExplainSlice, isBrushDrag, makeCategoricalRegion)", () => {
    // Categorical-only on Bar — the foundation's `makeTemporalRegion`
    // and `makeNumericRegion` aren't imported here because the bar's
    // x-axis is always categorical (band scale on enc.x.field). The
    // four imports lock the click-vs-drag threshold + categorical
    // region constructor + the SSR-safe dispatcher.
    assert.match(
      barSrc,
      /import\s*\{\s*BRUSH_MIN_PX\s*,\s*dispatchExplainSlice\s*,\s*isBrushDrag\s*,\s*makeCategoricalRegion\s*,?\s*\}\s*from\s*["']@\/pages\/Dashboard\/lib\/explainSlice["']/,
    );
  });

  it("does NOT import makeTemporalRegion or makeNumericRegion (categorical-only)", () => {
    // Bar charts have no temporal axis in the WI4 sense — the
    // outerScale is a band scale on categorical labels. Importing
    // either constructor would suggest the wave acquired a temporal
    // / numeric branch that doesn't apply.
    assert.doesNotMatch(barSrc, /makeTemporalRegion/);
    assert.doesNotMatch(barSrc, /makeNumericRegion/);
  });

  it("preserves the WD3-wiring-bar imports alongside the new WI4 imports", () => {
    // WD3 drill-through and WI4 explain-slice co-exist on this
    // renderer — both import blocks must remain present.
    assert.match(
      barSrc,
      /import\s*\{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\}\s*from\s*["']@\/pages\/Dashboard\/lib\/drillThrough["']/,
    );
  });

  it("uses the existing useEffect / useMemo / useRef / useState React import (already widened pre-wave)", () => {
    // BarRenderer already imported the hook quartet for prior waves
    // (brush state isn't this renderer's first useState/useEffect).
    // This pin guards against a regression that drops one of them.
    assert.match(
      barSrc,
      /import\s*\{\s*(?:memo\s*,\s*)?useEffect\s*,\s*useMemo\s*,\s*useRef\s*,\s*useState\s*\}\s*from\s*["']react["']/,
    );
  });
});

describe("WI4-wiring-bar · brush state declarations", () => {
  it("declares brushStart as useState<number | null>(null)", () => {
    // Pixel coord on the categorical axis (x for vertical / y for
    // horizontal); null when no brush is active.
    assert.match(
      barSrc,
      /const\s+\[\s*brushStart\s*,\s*setBrushStart\s*\]\s*=\s*useState<number\s*\|\s*null>\(\s*null\s*\)/,
    );
  });

  it("declares brushEnd as useState<number | null>(null)", () => {
    assert.match(
      barSrc,
      /const\s+\[\s*brushEnd\s*,\s*setBrushEnd\s*\]\s*=\s*useState<number\s*\|\s*null>\(\s*null\s*\)/,
    );
  });

  it("declares brushExplainRef as useRef<boolean>(false)", () => {
    // Ref (not state) because the alt flag doesn't drive a re-
    // render. Mirrors LineRenderer + AreaRenderer's pattern.
    assert.match(
      barSrc,
      /const\s+brushExplainRef\s*=\s*useRef<boolean>\(\s*false\s*\)/,
    );
  });

  it("comments the brush state with the WI4-wiring-bar wave marker", () => {
    // Wave-attribution comment co-located with the state it
    // introduces so future-Claude can grep the origin wave.
    assert.match(
      barSrc,
      /\/\/\s*Wave\s*WI4-wiring-bar\s*·[\s\S]{0,800}?const\s+\[\s*brushStart/,
    );
  });
});

describe("WI4-wiring-bar · data-change reset effect", () => {
  it("clears brushStart and brushEnd on a useEffect keyed on [data]", () => {
    // Stale brush coords on stale data (encoding-shelf change,
    // cross-filter applied, etc.) would render a misleading overlay.
    assert.match(
      barSrc,
      /useEffect\(\s*\(\)\s*=>\s*\{\s*setBrushStart\(null\)\s*;\s*setBrushEnd\(null\)\s*;\s*\}\s*,\s*\[\s*data\s*\]\s*\)/,
    );
  });
});

describe("WI4-wiring-bar · orientation-aware axis derivation", () => {
  it("derives `isVertical` from the existing `orientation` variable", () => {
    // Single source of truth — orientation is computed once at the
    // top of the body via pickOrientation. The brush axis math
    // collapses the two orientations into a single 1D brush so the
    // handlers stay orientation-agnostic.
    assert.match(
      barSrc,
      /const\s+isVertical\s*=\s*orientation\s*===\s*["']vertical["']/,
    );
  });

  it("derives `brushAxisSize` as innerWidth when vertical, innerHeight when horizontal", () => {
    // The categorical axis is x in vertical mode (innerWidth) and y
    // in horizontal mode (innerHeight). brushAxisSize is the
    // denominator in the i0/i1 derivation.
    assert.match(
      barSrc,
      /const\s+brushAxisSize\s*=\s*isVertical\s*\?\s*innerWidth\s*:\s*innerHeight/,
    );
  });

  it("derives `brushAxisOffset` as MARGIN.left when vertical, MARGIN.top when horizontal", () => {
    // The svg-relative coord minus the margin offset gives the
    // inner-plot coord. Vertical uses MARGIN.left (x dimension),
    // horizontal uses MARGIN.top (y dimension).
    assert.match(
      barSrc,
      /const\s+brushAxisOffset\s*=\s*isVertical\s*\?\s*MARGIN\.left\s*:\s*MARGIN\.top/,
    );
  });
});

describe("WI4-wiring-bar · alt capture at brushDown", () => {
  it("stashes `e.altKey === true` into brushExplainRef.current inside onBrushDown", () => {
    // Strict equality to literal `true` (NOT `!!e.altKey`) so an
    // undefined / missing altKey reliably yields false. Same shape
    // as LineRenderer + AreaRenderer.
    assert.match(
      barSrc,
      /brushExplainRef\.current\s*=\s*e\.altKey\s*===\s*true\s*;/,
    );
  });

  it("captures the orientation-aware coord via `(isVertical ? pt.x : pt.y) - brushAxisOffset`", () => {
    // Single ternary expression so the handlers stay tight. The
    // mouseMove handler uses the same expression to update
    // brushEnd; both compose with `brushAxisOffset` to land in
    // inner-plot coords.
    const downIdx = barSrc.indexOf("const onBrushDown =");
    const slice = barSrc.slice(downIdx, downIdx + 600);
    assert.match(
      slice,
      /const\s+coord\s*=\s*\(\s*isVertical\s*\?\s*pt\.x\s*:\s*pt\.y\s*\)\s*-\s*brushAxisOffset\s*;/,
    );
    assert.match(slice, /setBrushStart\(\s*coord\s*\)\s*;/);
    assert.match(slice, /setBrushEnd\(\s*coord\s*\)\s*;/);
  });

  it("guards brushDown against coords outside the brushAxisSize bounds", () => {
    // Defensive: a click on the y-axis label region (coord < 0) or
    // past the right edge (coord > brushAxisSize) doesn't start a
    // brush. The bound is `brushAxisSize` (not a literal) so the
    // guard tracks the categorical-axis size across orientations.
    const downIdx = barSrc.indexOf("const onBrushDown =");
    const slice = barSrc.slice(downIdx, downIdx + 600);
    assert.match(
      slice,
      /if\s*\(\s*coord\s*<\s*0\s*\|\|\s*coord\s*>\s*brushAxisSize\s*\)\s*return\s*;/,
    );
  });
});

describe("WI4-wiring-bar · onBrushMove drag update", () => {
  it("updates brushEnd only when a mouse button is held (gated on `e.buttons & 1`)", () => {
    // Without the button-held guard, plain mouse-move (hover) would
    // continuously update brushEnd and re-render the rect.
    const moveIdx = barSrc.indexOf("const onBrushMove =");
    const slice = barSrc.slice(moveIdx, moveIdx + 600);
    assert.match(
      slice,
      /if\s*\(\s*!\s*\(\s*e\.buttons\s*&\s*1\s*\)\s*\)\s*return\s*;/,
    );
  });

  it("clamps brushEnd to [0, brushAxisSize] across orientations", () => {
    // Math.max(0, Math.min(brushAxisSize, coord)) — orientation-
    // aware via brushAxisSize. A drag past the axis edges anchors
    // at 0 or brushAxisSize.
    const moveIdx = barSrc.indexOf("const onBrushMove =");
    const slice = barSrc.slice(moveIdx, moveIdx + 600);
    assert.match(
      slice,
      /setBrushEnd\(\s*Math\.max\(\s*0\s*,\s*Math\.min\(\s*brushAxisSize\s*,\s*coord\s*\)\s*\)\s*\)/,
    );
  });

  it("short-circuits when brushStart is null (no active brush)", () => {
    // Without this guard, every mouseMove during normal hovering
    // would unnecessarily reach the localPoint() call.
    const moveIdx = barSrc.indexOf("const onBrushMove =");
    const slice = barSrc.slice(moveIdx, moveIdx + 400);
    assert.match(slice, /if\s*\(\s*brushStart\s*===\s*null\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-bar · click-vs-drag threshold from foundation", () => {
  it("uses isBrushDrag(brushStart, brushEnd, BRUSH_MIN_PX) for the click-vs-drag split", () => {
    // Same threshold the foundation pins (6 px). The ! isBrushDrag
    // branch is the click case — onBrushUp resets state and yields
    // control to the per-bar onClick handler.
    assert.match(
      barSrc,
      /if\s*\(\s*!\s*isBrushDrag\(\s*brushStart\s*,\s*brushEnd\s*,\s*BRUSH_MIN_PX\s*\)\s*\)/,
    );
  });
});

describe("WI4-wiring-bar · explain-slice branch", () => {
  it("gates the explain dispatch on `brushExplainRef.current && dashboardTile`", () => {
    // AND-gated on dashboardTile because outside a dashboard the
    // panel has no receiver — same gating shape as LineRenderer +
    // AreaRenderer's WI4 wiring.
    assert.match(
      barSrc,
      /if\s*\(\s*brushExplainRef\.current\s*&&\s*dashboardTile\s*\)/,
    );
  });

  it("derives i0 / i1 from brush coords + brushAxisSize + xValues.length", () => {
    // The categorical brush maps pixel coords back to the band
    // scale's domain via index slicing. brushAxisSize (not innerWidth
    // / innerHeight inline) keeps the math orientation-agnostic.
    // xValues is the distinct-ordered list of categorical labels
    // (computed once via useMemo for the rest of the renderer).
    assert.match(
      barSrc,
      /const\s+i0\s*=\s*Math\.max\(\s*\n?\s*0\s*,\s*\n?\s*Math\.floor\(\s*\(\s*lo\s*\/\s*brushAxisSize\s*\)\s*\*\s*xValues\.length\s*\)\s*,?\s*\)/,
    );
    assert.match(
      barSrc,
      /const\s+i1\s*=\s*Math\.min\(\s*\n?\s*xValues\.length\s*,\s*\n?\s*Math\.ceil\(\s*\(\s*hi\s*\/\s*brushAxisSize\s*\)\s*\*\s*xValues\.length\s*\)\s*,?\s*\)/,
    );
  });

  it("builds a categorical region via `makeCategoricalRegion(xValues.slice(i0, i1))`", () => {
    // xValues.slice(i0, i1) is end-exclusive — same convention as
    // LineRenderer + AreaRenderer's categorical brush.
    assert.match(
      barSrc,
      /makeCategoricalRegion\(\s*xValues\.slice\(\s*i0\s*,\s*i1\s*\)\s*\)/,
    );
  });

  it("only dispatches when the constructor returns a non-null region (defensive)", () => {
    // makeCategoricalRegion returns null for an empty slice; the
    // dispatch is guarded so a malformed event never fires.
    assert.match(
      barSrc,
      /if\s*\(\s*region\s*\)\s*\{\s*\n[\s\S]*?dispatchExplainSlice/,
    );
  });
});

describe("WI4-wiring-bar · dispatch payload shape", () => {
  it("dispatches with chartId / column / region / sourceTileId / filters (5 fields)", () => {
    // Field-by-field pin. column = enc.x.field (the categorical
    // axis field, same as the WD2 cross-filter + WD3 drill-through
    // dispatches on this renderer — three concerns key on the same
    // axis).
    const dispatchIdx = barSrc.indexOf("dispatchExplainSlice({");
    const slice = barSrc.slice(dispatchIdx, dispatchIdx + 600);
    assert.match(slice, /chartId:\s*dashboardTile\.tileId/);
    assert.match(slice, /column:\s*enc\.x\.field/);
    assert.match(slice, /region,/);
    assert.match(slice, /sourceTileId:\s*dashboardTile\.tileId/);
    assert.match(slice, /filters:\s*dashboardFilters/);
  });
});

describe("WI4-wiring-bar · ref + state cleanup across all brushUp paths", () => {
  it("resets brushExplainRef.current = false and clears brush state after the click-path return", () => {
    // The click path (< BRUSH_MIN_PX) yields to the per-bar onClick
    // handler. The brush state must be cleared before the return so
    // the next brushDown starts fresh.
    const clickPathIdx = barSrc.indexOf("if (!isBrushDrag");
    assert.ok(clickPathIdx > 0, "click path branch present");
    const clickPathSlice = barSrc.slice(clickPathIdx, clickPathIdx + 400);
    assert.match(clickPathSlice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(clickPathSlice, /setBrushStart\(null\)\s*;/);
    assert.match(clickPathSlice, /setBrushEnd\(null\)\s*;/);
    assert.match(clickPathSlice, /return\s*;/);
  });

  it("resets brushExplainRef.current = false and clears brush state after the explain-slice dispatch", () => {
    // The explain path resets the ref and state so a subsequent
    // plain drag's brushDown overwrites them cleanly.
    const dispatchIdx = barSrc.indexOf("dispatchExplainSlice({");
    const slice = barSrc.slice(dispatchIdx, dispatchIdx + 800);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
  });
});

describe("WI4-wiring-bar · NO brush-to-zoom (negative pin)", () => {
  it("does NOT introduce setZoomRange in onBrushUp (Bar charts have no zoom)", () => {
    // Per the WI4-wiring-bar wave brief: Bar charts have no
    // quantitative axis to zoom into (the categorical axis would
    // just rearrange labels). The brush is exclusively for
    // explain-slice.
    assert.doesNotMatch(barSrc, /setZoomRange/);
  });
});

describe("WI4-wiring-bar · SVG handler attachment", () => {
  it("attaches onMouseDown, onMouseMove, onMouseUp to the svg (gated on dashboardTile)", () => {
    // Brush handlers at the svg level so the entire chart surface
    // captures the drag, not just the bars. Gated on dashboardTile
    // because outside a dashboard the brush has no receiver.
    assert.match(
      barSrc,
      /onMouseDown=\{\s*dashboardTile\s*\?\s*onBrushDown\s*:\s*undefined\s*\}/,
    );
    assert.match(
      barSrc,
      /onMouseMove=\{\s*dashboardTile\s*\?\s*onBrushMove\s*:\s*undefined\s*\}/,
    );
    assert.match(
      barSrc,
      /onMouseUp=\{\s*dashboardTile\s*\?\s*onBrushUp\s*:\s*undefined\s*\}/,
    );
  });

  it("extends onMouseLeave to clear brush state alongside hideTooltip()", () => {
    // The pre-wave onMouseLeave was just `onMouseLeave={hideTooltip}`.
    // This wave widens it to also clear brush state if the cursor
    // leaves the svg mid-drag (the next mouseUp would be outside
    // the element). Both hideTooltip and the reset must fire.
    const leaveIdx = barSrc.lastIndexOf("onMouseLeave=");
    assert.ok(leaveIdx > 0, "onMouseLeave present");
    const slice = barSrc.slice(leaveIdx, leaveIdx + 600);
    assert.match(slice, /hideTooltip\(\)/);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*\)/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
  });

  it("toggles cursor between ew-resize (vertical brush) and ns-resize (horizontal brush)", () => {
    // The svg-level cursor changes during a brush to reflect the
    // drag direction. Vertical bars have a horizontal categorical
    // axis (ew); horizontal bars have a vertical categorical axis
    // (ns). Per-bar `cursor: pointer` overrides the svg cursor on
    // bars themselves — that's fine, the brush rect provides
    // visual feedback during a drag.
    assert.match(
      barSrc,
      /brushStart\s*!==\s*null\s*\n?\s*\?\s*\{\s*cursor:\s*isVertical\s*\?\s*["']ew-resize["']\s*:\s*["']ns-resize["']\s*\}/,
    );
  });
});

describe("WI4-wiring-bar · brush rect overlay", () => {
  it("renders a `<rect>` overlay only when both brushStart and brushEnd are non-null", () => {
    // Conditional render — no overlay when no brush is active. The
    // `!== null` checks are load-bearing because brushStart === 0
    // is a valid value (brush starting at the left edge).
    assert.match(
      barSrc,
      /\{\s*brushStart\s*!==\s*null\s*&&\s*brushEnd\s*!==\s*null\s*&&\s*\(\s*\n\s*<rect/,
    );
  });

  it("renders an orientation-aware rect — full-height in vertical mode, full-width in horizontal", () => {
    // Vertical: x=Math.min(brushStart, brushEnd), y=0, width=
    // Math.abs(brushEnd - brushStart), height=innerHeight.
    // Horizontal: x=0, y=Math.min(...), width=innerWidth, height=
    // Math.abs(...). Both orientations covered in a single rect
    // with isVertical ternaries.
    const rectIdx = barSrc.lastIndexOf("<rect");
    assert.ok(rectIdx > 0, "<rect JSX element present");
    const slice = barSrc.slice(rectIdx, rectIdx + 800);
    assert.match(
      slice,
      /x=\{\s*isVertical\s*\?\s*Math\.min\(\s*brushStart\s*,\s*brushEnd\s*\)\s*:\s*0\s*\}/,
    );
    assert.match(
      slice,
      /y=\{\s*isVertical\s*\?\s*0\s*:\s*Math\.min\(\s*brushStart\s*,\s*brushEnd\s*\)\s*\}/,
    );
    assert.match(
      slice,
      /width=\{\s*isVertical\s*\?\s*Math\.abs\(\s*brushEnd\s*-\s*brushStart\s*\)\s*:\s*innerWidth\s*\}/,
    );
    assert.match(
      slice,
      /height=\{\s*\n?\s*isVertical\s*\?\s*innerHeight\s*:\s*Math\.abs\(\s*brushEnd\s*-\s*brushStart\s*\)\s*\n?\s*\}/,
    );
  });

  it("sets pointerEvents=\"none\" so the overlay never intercepts mouseUp / click", () => {
    // Without pointerEvents="none", the rect would absorb mouseUp /
    // mouseMove events during the latter half of a drag, breaking
    // the brush AND the per-bar onClick.
    const rectIdx = barSrc.lastIndexOf("<rect");
    const slice = barSrc.slice(rectIdx, rectIdx + 800);
    assert.match(slice, /pointerEvents=["']none["']/);
  });
});

describe("WI4-wiring-bar · per-bar tooltip suppression during active brush", () => {
  it("short-circuits per-bar onMouseMove tooltip when brushStart !== null", () => {
    // Without this guard, the tooltip would flicker between bars
    // as the cursor drags across the chart, fighting the brush
    // rect for the user's visual attention. The brush rect is
    // sufficient feedback during a drag.
    const tooltipBlockIdx = barSrc.indexOf(
      "onMouseMove={(e: React.MouseEvent<SVGElement>) => {",
    );
    assert.ok(tooltipBlockIdx > 0, "per-bar onMouseMove tooltip handler present");
    const slice = barSrc.slice(tooltipBlockIdx, tooltipBlockIdx + 500);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-bar · pre-existing per-bar click handlers preserved", () => {
  it("keeps the WD3 drill-through dispatch on the cmd/ctrl click path", () => {
    // WD3 wiring stays intact — the brush adds the WI4 alt-drag
    // intent without restructuring the click logic.
    assert.match(
      barSrc,
      /if\s*\(\s*dashboardTile\s*&&\s*isModifierClick\(\s*event\s*\)\s*\)\s*\{\s*\n\s*dispatchDrillThrough\(\{/,
    );
  });

  it("keeps the WD2 cross-filter dispatch on the plain click path", () => {
    // WD2 cross-filter on plain click is the default click intent.
    assert.match(
      barSrc,
      /dispatchCrossFilter\(\{\s*\n?\s*column:\s*enc\.x\.field/,
    );
  });

  it("keeps the chat/explorer grid.toggleFilter branch intact", () => {
    // BarRenderer is unique in supporting THREE click intent
    // contexts: chat/explorer grid (via ChartGrid), dashboard
    // cross-filter, dashboard drill-through. None should regress.
    assert.match(
      barSrc,
      /if\s*\(\s*grid\.inGrid\s*\)\s*\{\s*\n\s*grid\.toggleFilter\(\{/,
    );
  });
});

describe("WI4-wiring-bar · wave marker present", () => {
  it("includes the WI4-wiring-bar wave marker in the file (greppable lineage)", () => {
    // The marker lets future-Claude grep for the wave's wiring
    // surface; mirrors the WD3-wiring-bar + WI4-wiring-area marker
    // shape.
    assert.match(barSrc, /Wave\s*WI4-wiring-bar/);
  });
});
