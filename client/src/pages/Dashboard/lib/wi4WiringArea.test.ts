/**
 * Wave WI4-wiring-area · source-inspection tests for AreaRenderer's
 * alt-drag → explain-this-slice wiring.
 *
 * AreaRenderer had NO pre-existing brush mechanics (only an onClick
 * handler powering WD2 cross-filter + WD3 drill-through). This wave
 * adds the mouse-down / move / up state + a `<rect>` overlay from
 * scratch (mirroring LineRenderer's shape) so an alt-drag dispatches
 * an `ExplainSliceEvent`. The wave deliberately omits a brush-to-
 * zoom branch — Area charts rarely warrant zoom and the
 * disambiguation complexity LineRenderer has (plain drag = zoom,
 * alt drag = explain) is unwarranted here. Plain drag is a no-op;
 * click paths flow through the existing onClick handler unchanged.
 *
 * Tests pin: explainSlice import shape; React state / ref imports;
 * brushStart / brushEnd useState declarations; brushExplainRef
 * useRef declaration; useEffect data-change reset; onBrushDown
 * capture shape (alt + position); onBrushMove drag update (gated on
 * mouse button held); onBrushUp threshold via `isBrushDrag(... ,
 * BRUSH_MIN_PX)`; explain branch gated on `brushExplainRef.current
 * && dashboardTile`; temporal vs categorical region computation;
 * dispatch payload (5 fields); ref + state reset after all paths;
 * NEGATIVE pin against setZoomRange (Area must NOT acquire a
 * brush-to-zoom by accident); SVG handler attachment + cursor
 * affordance; brush rect overlay; existing WD2 + WD3 click branches
 * preserved unchanged.
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

describe("WI4-wiring-area · explainSlice imports", () => {
  it("imports the five WI4-foundation helpers from explainSlice (BRUSH_MIN_PX, dispatchExplainSlice, isBrushDrag, makeCategoricalRegion, makeTemporalRegion)", () => {
    // Foundation module is the single source of truth for the
    // click-vs-drag threshold + region constructors. Importing
    // BRUSH_MIN_PX (instead of redeclaring 6 inline) locks the
    // threshold to the same value the foundation pins.
    assert.match(
      areaSrc,
      /import\s*\{\s*[\s\S]*?BRUSH_MIN_PX[\s\S]*?dispatchExplainSlice[\s\S]*?isBrushDrag[\s\S]*?makeCategoricalRegion[\s\S]*?makeTemporalRegion[\s\S]*?\}\s*from\s*["']@\/pages\/Dashboard\/lib\/explainSlice["']/,
    );
  });

  it("preserves the WD3-wiring-rest-trend imports alongside the new WI4 imports", () => {
    // The two wiring waves co-exist on the same renderer — drill
    // through fires on the click path, explain-slice on the brush
    // path. Both import blocks must remain present.
    assert.match(
      areaSrc,
      /import\s*\{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\}\s*from\s*["']@\/pages\/Dashboard\/lib\/drillThrough["']/,
    );
  });

  it("widens the react import to include useEffect / useRef / useState", () => {
    // AreaRenderer was previously a pure `useMemo`-only renderer.
    // The brush state + ref + data-reset effect require three new
    // hooks. Pin the import shape so a future cleanup doesn't drop
    // any of them and silently break the brush.
    assert.match(
      areaSrc,
      /import\s*\{\s*useEffect\s*,\s*useMemo\s*,\s*useRef\s*,\s*useState\s*\}\s*from\s*["']react["']/,
    );
  });
});

describe("WI4-wiring-area · brush state declarations", () => {
  it("declares brushStart as useState<number | null>(null)", () => {
    // Number = pixel x-coordinate of the brush-down point in inner-
    // plot space (svg x minus MARGIN.left). Null when no brush is
    // active. Identical shape to LineRenderer's brushStart.
    assert.match(
      areaSrc,
      /const\s+\[\s*brushStart\s*,\s*setBrushStart\s*\]\s*=\s*useState<number\s*\|\s*null>\(\s*null\s*\)/,
    );
  });

  it("declares brushEnd as useState<number | null>(null)", () => {
    // Number = current pixel x-coordinate of the brush during drag;
    // null when no brush is active. Updated by onBrushMove during a
    // held drag.
    assert.match(
      areaSrc,
      /const\s+\[\s*brushEnd\s*,\s*setBrushEnd\s*\]\s*=\s*useState<number\s*\|\s*null>\(\s*null\s*\)/,
    );
  });

  it("declares brushExplainRef as useRef<boolean>(false)", () => {
    // Ref (not state) because the alt flag doesn't drive a re-
    // render. Mirrors LineRenderer's brushExplainRef. Captured at
    // brushDown, consumed at brushUp.
    assert.match(
      areaSrc,
      /const\s+brushExplainRef\s*=\s*useRef<boolean>\(\s*false\s*\)/,
    );
  });

  it("comments the brush state with the WI4-wiring-area wave marker", () => {
    // Wave-attribution comment so future-Claude can grep for the
    // origin wave. Anchored on brushStart so the marker is co-
    // located with the state it introduces.
    assert.match(
      areaSrc,
      /\/\/\s*Wave\s*WI4-wiring-area\s*·[\s\S]{0,600}?const\s+\[\s*brushStart/,
    );
  });
});

describe("WI4-wiring-area · data-change reset effect", () => {
  it("clears brushStart and brushEnd on a useEffect keyed on [data]", () => {
    // Stale brush coords on stale data (encoding-shelf change,
    // cross-filter applied, etc.) would render a misleading overlay
    // — the reset on data change is the same pattern LineRenderer
    // uses for its brush + zoom state.
    assert.match(
      areaSrc,
      /useEffect\(\s*\(\)\s*=>\s*\{\s*setBrushStart\(null\)\s*;\s*setBrushEnd\(null\)\s*;\s*\}\s*,\s*\[\s*data\s*\]\s*\)/,
    );
  });
});

describe("WI4-wiring-area · alt capture at brushDown", () => {
  it("stashes `e.altKey === true` into brushExplainRef.current inside onBrushDown", () => {
    // Captured at brushDown so the parameterless onBrushUp can read
    // it. Strict equality to literal `true` (NOT `!!e.altKey`) so
    // an undefined / missing altKey reliably yields false rather
    // than coercing through a Boolean cast.
    assert.match(
      areaSrc,
      /brushExplainRef\.current\s*=\s*e\.altKey\s*===\s*true\s*;/,
    );
  });

  it("sets brushStart and brushEnd to the click x-coordinate inside onBrushDown", () => {
    // Both refs initialised to the same x at brushDown — onBrushMove
    // later widens brushEnd as the cursor drags. Subtracts MARGIN.left
    // so the coords are in inner-plot space (consistent with the
    // brush rect render and the onBrushUp arithmetic).
    const downIdx = areaSrc.indexOf("const onBrushDown =");
    const slice = areaSrc.slice(downIdx, downIdx + 500);
    assert.match(slice, /const\s+x\s*=\s*pt\.x\s*-\s*MARGIN\.left\s*;/);
    assert.match(slice, /setBrushStart\(\s*x\s*\)\s*;/);
    assert.match(slice, /setBrushEnd\(\s*x\s*\)\s*;/);
  });

  it("guards brushDown against clicks outside the inner-plot bounds", () => {
    // Defensive: a click on the y-axis label region (x < 0) or in
    // the right margin (x > innerWidth) doesn't start a brush.
    // Same guard shape LineRenderer's onBrushDown uses.
    const downIdx = areaSrc.indexOf("const onBrushDown =");
    const slice = areaSrc.slice(downIdx, downIdx + 500);
    assert.match(slice, /if\s*\(\s*x\s*<\s*0\s*\|\|\s*x\s*>\s*innerWidth\s*\)\s*return\s*;/);
  });
});

describe("WI4-wiring-area · onMouseMove drag update", () => {
  // WHov-area-crosshair · onBrushMove was renamed to onMouseMove
  // when the combined handler (brush drag + hover tooltip) landed.
  // The brush-drag portion of the handler still gates on brushStart
  // and e.buttons — tests widen to search onMouseMove instead.
  it("updates brushEnd only when a mouse button is held (gated on `e.buttons & 1`)", () => {
    // WHov-area-crosshair · the button guard merged into the
    // brushStart conditional: `if (brushStart !== null && (e.buttons & 1))`.
    const moveIdx = areaSrc.indexOf("const onMouseMove =");
    const slice = areaSrc.slice(moveIdx, moveIdx + 800);
    assert.match(slice, /e\.buttons\s*&\s*1/);
  });

  it("clamps brushEnd to [0, innerWidth] so a drag past the axis edges doesn't overflow", () => {
    const moveIdx = areaSrc.indexOf("const onMouseMove =");
    const slice = areaSrc.slice(moveIdx, moveIdx + 800);
    assert.match(
      slice,
      /setBrushEnd\(\s*Math\.max\(\s*0\s*,\s*Math\.min\(\s*innerWidth\s*,\s*x\s*\)\s*\)\s*\)/,
    );
  });

  it("gates brush update on brushStart !== null (no brush end update outside a drag)", () => {
    // WHov-area-crosshair · the guard moved from a top-of-function
    // early-return to a conditional block wrapping the setBrushEnd
    // call: `if (brushStart !== null && (e.buttons & 1))`.
    const moveIdx = areaSrc.indexOf("const onMouseMove =");
    const slice = areaSrc.slice(moveIdx, moveIdx + 800);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*&&\s*\(\s*e\.buttons\s*&\s*1\s*\)\s*\)/);
  });
});

describe("WI4-wiring-area · click-vs-drag threshold from foundation", () => {
  it("uses isBrushDrag(brushStart, brushEnd, BRUSH_MIN_PX) for the click-vs-drag split", () => {
    // Same threshold the foundation pins (BRUSH_MIN_PX = 6). The
    // ! isBrushDrag branch is the click case — onBrushUp resets
    // state and yields control to the existing onClick handler.
    assert.match(
      areaSrc,
      /if\s*\(\s*!\s*isBrushDrag\(\s*brushStart\s*,\s*brushEnd\s*,\s*BRUSH_MIN_PX\s*\)\s*\)/,
    );
  });

  it("does NOT inline a `< 6` literal threshold (negative pin against drift)", () => {
    // The threshold lives in the foundation. If a future refactor
    // re-introduces an inline `< 6`, the foundation's pin would
    // silently desync. Negative pin catches that.
    assert.doesNotMatch(areaSrc, /Math\.abs\([^)]*\)\s*<\s*6/);
  });
});

describe("WI4-wiring-area · explain-slice branch", () => {
  it("gates the explain dispatch on `brushExplainRef.current && dashboardTile`", () => {
    // AND-gated on dashboardTile because outside a dashboard the
    // panel has no receiver — same gating shape as LineRenderer's
    // WI4 wiring and the WD3 click path's `if (dashboardTile)`.
    assert.match(
      areaSrc,
      /if\s*\(\s*brushExplainRef\.current\s*&&\s*dashboardTile\s*\)/,
    );
  });

  it("builds a temporal region via `makeTemporalRegion(startMs, endMs)` when isTemporal", () => {
    // The math reuses the same domain min/max + linear-interpolation
    // shape LineRenderer uses for its temporal brush. Keeps the two
    // renderers' brushes data-space-aligned.
    assert.match(
      areaSrc,
      /region\s*=\s*makeTemporalRegion\(\s*startMs\s*,\s*endMs\s*\)/,
    );
  });

  it("computes startMs / endMs from the time scale's domain bounds + brush pixel coords", () => {
    // Exact math: domMin + (lo / innerWidth) * (domMax - domMin).
    // Same shape LineRenderer uses. Test pins the interpolation
    // so a future refactor breaks loudly.
    assert.match(
      areaSrc,
      /const\s+startMs\s*=\s*domMin\s*\+\s*\(\s*lo\s*\/\s*innerWidth\s*\)\s*\*\s*\(\s*domMax\s*-\s*domMin\s*\)/,
    );
    assert.match(
      areaSrc,
      /const\s+endMs\s*=\s*domMin\s*\+\s*\(\s*hi\s*\/\s*innerWidth\s*\)\s*\*\s*\(\s*domMax\s*-\s*domMin\s*\)/,
    );
  });

  it("builds a categorical region via `makeCategoricalRegion(xs.slice(i0, i1))` when NOT isTemporal", () => {
    // For a categorical x-axis, the brush captures a contiguous
    // slice of the unique x-values. `xs.slice(i0, i1)` is end-
    // exclusive — same convention as LineRenderer's brush.
    assert.match(
      areaSrc,
      /region\s*=\s*makeCategoricalRegion\(\s*xs\.slice\(\s*i0\s*,\s*i1\s*\)\s*\)/,
    );
  });

  it("derives i0 / i1 from the brush pixel coords + xs length", () => {
    // Math.max(0, Math.floor(...)) + Math.min(xs.length, Math.ceil
    // (...)). Same shape as LineRenderer's brush math. The i1 closer
    // allows a trailing comma after Math.ceil(...) because Prettier
    // splits the Math.min args across lines (xs.length is a separate
    // argument from the Math.ceil(...) expression).
    assert.match(
      areaSrc,
      /const\s+i0\s*=\s*Math\.max\(\s*0\s*,\s*Math\.floor\(\s*\(\s*lo\s*\/\s*innerWidth\s*\)\s*\*\s*xs\.length\s*\)\s*\)/,
    );
    assert.match(
      areaSrc,
      /const\s+i1\s*=\s*Math\.min\(\s*[\s\S]{0,40}?xs\.length\s*,\s*Math\.ceil\(\s*\(\s*hi\s*\/\s*innerWidth\s*\)\s*\*\s*xs\.length\s*\)\s*,?\s*\)/,
    );
  });

  it("only dispatches when the constructor returns a non-null region (defensive)", () => {
    // makeTemporalRegion / makeCategoricalRegion return null for
    // zero-width / empty brushes — the dispatch is guarded so a
    // malformed event never fires.
    assert.match(
      areaSrc,
      /if\s*\(\s*region\s*\)\s*\{\s*\n[\s\S]*?dispatchExplainSlice/,
    );
  });
});

describe("WI4-wiring-area · dispatch payload shape", () => {
  it("dispatches with chartId / column / region / sourceTileId / filters (5 fields)", () => {
    // Field-by-field pin so a future widening (e.g. adding
    // `aggregation` or `seriesField`) is an explicit edit, not a
    // silent drift. Same shape as LineRenderer's WI4 dispatch.
    const dispatchIdx = areaSrc.indexOf("dispatchExplainSlice({");
    const slice = areaSrc.slice(dispatchIdx, dispatchIdx + 600);
    assert.match(slice, /chartId:\s*dashboardTile\.tileId/);
    assert.match(slice, /column:\s*xCh\.field/);
    assert.match(slice, /region,/);
    assert.match(slice, /sourceTileId:\s*dashboardTile\.tileId/);
    assert.match(slice, /filters:\s*dashboardFilters/);
  });
});

describe("WI4-wiring-area · ref + state cleanup across all brushUp paths", () => {
  it("resets brushExplainRef.current = false and clears brush state after the click-path return", () => {
    // The click path (< BRUSH_MIN_PX) yields to the existing onClick
    // handler. The brush state must be cleared before the return so
    // the next brushDown starts fresh. Anchor on the click-path
    // condition in the full file (the onBrushUp body is verbose due
    // to leading docstring) and walk forward 400 chars.
    const clickPathIdx = areaSrc.indexOf("if (!isBrushDrag");
    assert.ok(clickPathIdx > 0, "click path branch present");
    const clickPathSlice = areaSrc.slice(clickPathIdx, clickPathIdx + 400);
    assert.match(clickPathSlice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(clickPathSlice, /setBrushStart\(null\)\s*;/);
    assert.match(clickPathSlice, /setBrushEnd\(null\)\s*;/);
    assert.match(clickPathSlice, /return\s*;/);
  });

  it("resets brushExplainRef.current = false and clears brush state after the explain-slice dispatch", () => {
    // The explain path resets the ref and state so a subsequent
    // plain drag's brushDown overwrites them cleanly.
    const dispatchIdx = areaSrc.indexOf("dispatchExplainSlice({");
    const slice = areaSrc.slice(dispatchIdx, dispatchIdx + 800);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
  });
});

describe("WI4-wiring-area · NO brush-to-zoom (negative pin)", () => {
  it("does NOT introduce setZoomRange in onBrushUp (deliberate scope decision)", () => {
    // Per the WI4-wiring-area wave brief: Area charts rarely warrant
    // brush-to-zoom, and avoiding zoom keeps the brush exclusively
    // for explain-slice (no plain-drag-vs-alt-drag disambiguation
    // needed). A future wave could add zoom if user research
    // suggests otherwise.
    assert.doesNotMatch(areaSrc, /setZoomRange/);
  });

  it("does NOT declare a zoomRange state (would imply zoom support)", () => {
    // Stronger negative pin — even unused, a zoomRange state would
    // signal an in-progress brush-to-zoom that future readers
    // shouldn't assume exists.
    assert.doesNotMatch(areaSrc, /useState<\[number\s*,\s*number\]/);
  });
});

describe("WI4-wiring-area · SVG handler attachment", () => {
  it("attaches onMouseDown and onMouseUp gated on dashboardTile, and onMouseMove always-wired", () => {
    // WHov-area-crosshair · onMouseMove is now always-wired (not
    // gated on dashboardTile) because the combined handler does both
    // brush-drag (gated internally on brushStart) AND hover tooltip.
    // onMouseDown and onMouseUp remain dashboard-gated since the
    // brush mechanics only make sense inside a dashboard tile.
    assert.match(
      areaSrc,
      /onMouseDown=\{\s*dashboardTile\s*\?\s*onBrushDown\s*:\s*undefined\s*\}/,
    );
    assert.match(
      areaSrc,
      /onMouseMove=\{\s*onMouseMove\s*\}/,
    );
    assert.match(
      areaSrc,
      /onMouseUp=\{\s*dashboardTile\s*\?\s*onBrushUp\s*:\s*undefined\s*\}/,
    );
  });

  it("attaches onMouseLeave that clears in-flight brush state", () => {
    // If the cursor leaves the svg mid-drag, the brushUp never fires
    // (the next mouseUp is outside the element). onMouseLeave is the
    // safety net — clears brushStart / brushEnd / brushExplainRef so
    // the next brushDown starts fresh.
    const leaveIdx = areaSrc.indexOf("onMouseLeave=");
    assert.ok(leaveIdx > 0, "onMouseLeave present");
    const slice = areaSrc.slice(leaveIdx, leaveIdx + 600);
    assert.match(slice, /if\s*\(\s*brushStart\s*!==\s*null\s*\)/);
    assert.match(slice, /setBrushStart\(null\)\s*;/);
    assert.match(slice, /setBrushEnd\(null\)\s*;/);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
  });

  it("toggles cursor between ew-resize (active brush) and pointer (idle, in a dashboard)", () => {
    // ew-resize during a drag matches LineRenderer's affordance. The
    // pointer cursor outside a drag matches the pre-wave WD2 click
    // affordance. Style is computed inline on the svg element.
    assert.match(areaSrc, /brushStart\s*!==\s*null\s*\?\s*\{\s*cursor:\s*["']ew-resize["']\s*\}/);
    assert.match(areaSrc, /:\s*dashboardTile\s*\n?\s*\?\s*\{\s*cursor:\s*["']pointer["']\s*\}/);
  });
});

describe("WI4-wiring-area · brush rect overlay", () => {
  it("renders a `<rect>` overlay only when both brushStart and brushEnd are non-null", () => {
    // Conditional render — no overlay when no brush is active. The
    // `!== null` check (instead of truthy) is load-bearing because
    // brushStart === 0 is a valid value (brush starting at the left
    // edge of the inner plot).
    assert.match(
      areaSrc,
      /\{\s*brushStart\s*!==\s*null\s*&&\s*brushEnd\s*!==\s*null\s*&&\s*\(\s*\n\s*<rect/,
    );
  });

  it("anchors the rect at Math.min(brushStart, brushEnd) so reverse drags render correctly", () => {
    // A drag from right-to-left has brushStart > brushEnd. The rect
    // anchors at the lesser of the two; width is the absolute diff.
    assert.match(
      areaSrc,
      /x=\{\s*Math\.min\(\s*brushStart\s*,\s*brushEnd\s*\)\s*\}/,
    );
    assert.match(
      areaSrc,
      /width=\{\s*Math\.abs\(\s*brushEnd\s*-\s*brushStart\s*\)\s*\}/,
    );
  });

  it("sets pointerEvents=\"none\" so the overlay never intercepts mouse events", () => {
    // Without pointerEvents="none", the rect would absorb mouseUp /
    // mouseMove events during the latter half of a drag, breaking
    // the drag. Anchor on the JSX element opening (`<rect\n`) rather
    // than the bare substring `<rect` — the WI4 import-block comment
    // mentions `\`<rect>\` overlay` and would otherwise match first.
    const rectIdx = areaSrc.indexOf("<rect\n");
    assert.ok(rectIdx > 0, "<rect JSX element present");
    const slice = areaSrc.slice(rectIdx, rectIdx + 600);
    assert.match(slice, /pointerEvents=["']none["']/);
  });
});

describe("WI4-wiring-area · pre-existing click handlers preserved", () => {
  it("keeps the WD3 drill-through dispatch on the cmd/ctrl click path", () => {
    // WD3 wiring stays intact — alt-drag and cmd-click are mutually
    // exclusive in practice (alt-drag triggers brushUp not click;
    // cmd-click triggers click not brushUp), but the negative pin
    // ensures the prior wave's wiring isn't accidentally removed.
    assert.match(
      areaSrc,
      /if\s*\(\s*isModifierClick\(\s*e\s*\)\s*\)\s*\{\s*\n\s*dispatchDrillThrough\(\{/,
    );
  });

  it("keeps the WD2 cross-filter dispatch on the plain click path", () => {
    // WD2 cross-filter on plain click is the default click intent
    // (cmd-click drills, alt-drag explains, plain click filters).
    // The dispatchCrossFilter call must remain reachable.
    assert.match(
      areaSrc,
      /dispatchCrossFilter\(\{\s*column:\s*xCh\.field/,
    );
  });

  it("keeps the existing svg onClick handler (gated on dashboardTile)", () => {
    // The brush handlers and the click handler co-exist. A clean
    // click (no drag) fires mouseDown → mouseUp (small-distance
    // reset) → click (existing dispatch). The click handler must
    // remain present.
    assert.match(
      areaSrc,
      /onClick=\{\s*\n?\s*dashboardTile\s*\n?\s*\?\s*\(\s*e:\s*React\.MouseEvent<SVGElement>\s*\)/,
    );
  });
});

describe("WI4-wiring-area · wave marker present", () => {
  it("includes the WI4-wiring-area wave marker in the file (greppable lineage)", () => {
    // The marker lets future-Claude grep for the wave's wiring
    // surface; mirrors the WD3-wiring-rest-trend + WI4-wiring-trend
    // marker shape.
    assert.match(areaSrc, /Wave\s*WI4-wiring-area/);
  });
});
