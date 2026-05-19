/**
 * Wave WI4-wiring-trend · source-inspection tests for LineRenderer's
 * alt-drag → explain-this-slice wiring.
 *
 * LineRenderer already had brush-to-zoom mechanics (plain drag) and
 * a WD3-wiring-rest-trend click branch (small drag with cmd/ctrl
 * → drill-through). This wave layers the THIRD click-intent: a
 * full-distance drag (>= BRUSH_MIN_PX = 6) with the ALT key held
 * dispatches an `ExplainSliceEvent` carrying the brushed sub-domain
 * in data-space (temporal: { startMs, endMs }; categorical:
 * { values }). Plain drag continues to zoom; cmd/ctrl-click continues
 * to drill-through; the three intents are mutually exclusive at
 * brush-down time via the modifier flags captured in refs.
 *
 * AreaRenderer's brush wiring lives in a follow-on WI4-wiring-area
 * wave (AreaRenderer has no current brush mechanics — adding the
 * mouse-down/move/up state is a separate wave). BarRenderer
 * similarly in WI4-wiring-bar.
 *
 * Tests pin: explainSlice import shape; brushExplainRef declaration
 * at the top of LineRenderer; alt capture at brushDown; click-vs-
 * drag threshold now derived from `isBrushDrag(... , BRUSH_MIN_PX)`
 * (replaces inline `< 6`); explain-slice branch BEFORE the zoom
 * branch; data-space region computation per axis kind; dispatch
 * payload shape mirroring DrillThroughEvent (chartId / column /
 * sourceTileId / filters) plus the load-bearing `region` field;
 * reset of both refs after dispatch + after the click path; the
 * existing zoom path remains intact for plain drags.
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

describe("WI4-wiring-trend · explainSlice imports", () => {
  it("imports the five WI4-foundation helpers from explainSlice (BRUSH_MIN_PX, dispatchExplainSlice, isBrushDrag, makeCategoricalRegion, makeTemporalRegion)", () => {
    // The foundation module is the single source of truth for the
    // click-vs-drag threshold + region constructors. Importing
    // BRUSH_MIN_PX (instead of redeclaring 6 inline) locks the
    // threshold to the same value the foundation tests pin.
    assert.match(
      lineSrc,
      /import\s*\{\s*[\s\S]*?BRUSH_MIN_PX[\s\S]*?dispatchExplainSlice[\s\S]*?isBrushDrag[\s\S]*?makeCategoricalRegion[\s\S]*?makeTemporalRegion[\s\S]*?\}\s*from\s*["']@\/pages\/Dashboard\/lib\/explainSlice["']/,
    );
  });

  it("preserves the WD3-wiring-rest-trend imports alongside the new WI4 imports", () => {
    // The two wiring waves co-exist on the same renderer — both
    // import blocks must remain present.
    assert.match(
      lineSrc,
      /import\s*\{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\}\s*from\s*["']@\/pages\/Dashboard\/lib\/drillThrough["']/,
    );
  });
});

describe("WI4-wiring-trend · brushExplainRef declaration", () => {
  it("declares brushExplainRef as useRef<boolean>(false) alongside brushModifierRef", () => {
    // Ref (not state) because the alt flag doesn't drive a re-render
    // — only the brush rectangle does. Same shape decision as
    // brushModifierRef from WD3-wiring-rest-trend.
    assert.match(
      lineSrc,
      /const\s+brushExplainRef\s*=\s*useRef<boolean>\(\s*false\s*\)/,
    );
  });

  it("comments brushExplainRef with the WI4-wiring-trend wave marker", () => {
    // Wave-attribution comment so future-Claude can grep for the
    // origin wave when touching this ref.
    assert.match(
      lineSrc,
      /\/\/\s*Wave\s*WI4-wiring-trend\s*·[\s\S]{0,800}?brushExplainRef/,
    );
  });
});

describe("WI4-wiring-trend · alt capture at brushDown", () => {
  it("stashes `e.altKey === true` into brushExplainRef.current inside onBrushDown", () => {
    // Captured at brushDown so the parameterless onBrushUp can read
    // it. Compares to literal `true` (NOT `!!e.altKey`) so an
    // undefined / missing altKey reliably yields false rather than
    // coercing through a Boolean cast.
    assert.match(
      lineSrc,
      /brushExplainRef\.current\s*=\s*e\.altKey\s*===\s*true\s*;/,
    );
  });

  it("captures the alt flag AFTER the brushModifier capture (canonical order)", () => {
    // The two ref-captures live in sequence at the end of
    // onBrushDown. Ordering is canonical (cmd/ctrl first, then alt)
    // so future readers don't have to mentally re-order them when
    // reasoning about the intent chain.
    const modifierIdx = lineSrc.indexOf("brushModifierRef.current = isModifierClick(e)");
    const explainIdx = lineSrc.indexOf("brushExplainRef.current = e.altKey === true");
    assert.ok(modifierIdx > 0, "brushModifierRef capture present");
    assert.ok(explainIdx > 0, "brushExplainRef capture present");
    assert.ok(
      explainIdx > modifierIdx,
      "brushExplainRef capture should follow brushModifierRef in onBrushDown",
    );
  });
});

describe("WI4-wiring-trend · click-vs-drag threshold from foundation", () => {
  it("uses isBrushDrag(brushStart, brushEnd, BRUSH_MIN_PX) for the click-vs-drag split", () => {
    // The inline `Math.abs(hi - lo) < 6` check is replaced with the
    // foundation helper. Semantically identical (! isBrushDrag is
    // the click case); behavioural pin against future drift in
    // either side.
    assert.match(
      lineSrc,
      /if\s*\(\s*!\s*isBrushDrag\(\s*brushStart\s*,\s*brushEnd\s*,\s*BRUSH_MIN_PX\s*\)\s*\)/,
    );
  });

  it("removes the inline `Math.abs(hi - lo) < 6` literal threshold (negative pin against re-introduction)", () => {
    // The inline literal is gone; if a future refactor restores it,
    // the foundation's threshold pin would silently desync. Negative
    // pin catches that drift.
    assert.doesNotMatch(lineSrc, /Math\.abs\(\s*hi\s*-\s*lo\s*\)\s*<\s*6/);
  });
});

describe("WI4-wiring-trend · explain-slice branch sits BEFORE the zoom branch", () => {
  it("the explain-slice branch is gated on `brushExplainRef.current && dashboardTile`", () => {
    // AND-gated on dashboardTile because outside a dashboard the
    // panel has no receiver — same gating shape as the WD3 click
    // path's `if (dashboardTile)`.
    assert.match(
      lineSrc,
      /if\s*\(\s*brushExplainRef\.current\s*&&\s*dashboardTile\s*\)/,
    );
  });

  it("dispatches `dispatchExplainSlice` BEFORE the `if (isTemporal)` zoom branch", () => {
    // Ordering matters: a clean alt-drag should NOT also zoom the
    // axis. The early return in the explain branch keeps the two
    // intents mutually exclusive at brush-up time.
    const explainBranchIdx = lineSrc.indexOf(
      "if (brushExplainRef.current && dashboardTile)",
    );
    const dispatchIdx = lineSrc.indexOf("dispatchExplainSlice({");
    // There are TWO `if (isTemporal)` occurrences in the file: the
    // first is in the explain branch itself (region kind branch),
    // the second is the zoom branch we want to come AFTER. Find the
    // SECOND `if (isTemporal)` — anchor on the surrounding zoom
    // arithmetic.
    const zoomBranchIdx = lineSrc.indexOf(
      "if (isTemporal) {\n      const dom = (xScale as ReturnType<typeof scaleTime",
    );
    assert.ok(explainBranchIdx > 0, "explain branch present");
    assert.ok(dispatchIdx > 0, "dispatchExplainSlice call present");
    assert.ok(zoomBranchIdx > 0, "zoom branch anchor present");
    assert.ok(
      explainBranchIdx < dispatchIdx && dispatchIdx < zoomBranchIdx,
      "explain branch + dispatch must precede the zoom branch",
    );
  });

  it("returns from onBrushUp after the explain-slice dispatch (single-intent)", () => {
    // Bare `return;` after the brushExplainRef + state resets so
    // the zoom path doesn't also fire. Mirrors the click-path
    // `return;` shape.
    const dispatchIdx = lineSrc.indexOf("dispatchExplainSlice({");
    const slice = lineSrc.slice(dispatchIdx, dispatchIdx + 600);
    assert.match(slice, /setBrushEnd\(null\);\s*return;/);
  });
});

describe("WI4-wiring-trend · temporal region computation", () => {
  it("builds a temporal region via `makeTemporalRegion(startMs, endMs)` when isTemporal", () => {
    // The math reuses the existing zoom-temporal arithmetic:
    // domain min/max from the time scale, then linear-interpolated
    // by (lo / innerWidth) and (hi / innerWidth).
    assert.match(lineSrc, /region\s*=\s*makeTemporalRegion\(\s*startMs\s*,\s*endMs\s*\)/);
  });

  it("computes startMs / endMs from the time scale's domain bounds + brush pixel coords", () => {
    // The exact math: domMin + (lo / innerWidth) * (domMax - domMin)
    // — same shape as the existing zoom path. Test pins the
    // interpolation formula so a future refactor that changes the
    // brush-to-domain projection breaks loudly.
    assert.match(
      lineSrc,
      /const\s+startMs\s*=\s*domMin\s*\+\s*\(\s*lo\s*\/\s*innerWidth\s*\)\s*\*\s*\(\s*domMax\s*-\s*domMin\s*\)/,
    );
    assert.match(
      lineSrc,
      /const\s+endMs\s*=\s*domMin\s*\+\s*\(\s*hi\s*\/\s*innerWidth\s*\)\s*\*\s*\(\s*domMax\s*-\s*domMin\s*\)/,
    );
  });
});

describe("WI4-wiring-trend · categorical region computation", () => {
  it("builds a categorical region via `makeCategoricalRegion(xs.slice(i0, i1))` when NOT isTemporal", () => {
    // For a categorical x-axis, the brush captures a contiguous
    // slice of the unique x-values. Note `xs.slice(i0, i1)` —
    // end-exclusive (the existing zoom branch uses `i1` as the
    // ceiling index, NOT i1+1).
    assert.match(
      lineSrc,
      /region\s*=\s*makeCategoricalRegion\(\s*xs\.slice\(\s*i0\s*,\s*i1\s*\)\s*\)/,
    );
  });

  it("derives i0 / i1 from the brush pixel coords + xs length (parallels the zoom branch)", () => {
    // The same Math.max(0, Math.floor(...)) + Math.min(xs.length,
    // Math.ceil(...)) shape as the zoom branch — keeps the brush
    // region and the zoom range aligned in data-space.
    assert.match(
      lineSrc,
      /const\s+i0\s*=\s*Math\.max\(\s*0\s*,\s*Math\.floor\(\s*\(\s*lo\s*\/\s*innerWidth\s*\)\s*\*\s*xs\.length\s*\)\s*\)/,
    );
    assert.match(
      lineSrc,
      /const\s+i1\s*=\s*Math\.min\(\s*xs\.length\s*,\s*Math\.ceil\(\s*\(\s*hi\s*\/\s*innerWidth\s*\)\s*\*\s*xs\.length\s*\)\s*\)/,
    );
  });
});

describe("WI4-wiring-trend · dispatch payload shape", () => {
  it("dispatches with chartId / column / region / sourceTileId / filters (5 fields)", () => {
    // Field-by-field pin so a future widening (e.g. adding
    // `aggregation` or `seriesField`) is an explicit edit, not a
    // silent drift.
    const dispatchIdx = lineSrc.indexOf("dispatchExplainSlice({");
    const slice = lineSrc.slice(dispatchIdx, dispatchIdx + 600);
    assert.match(slice, /chartId:\s*dashboardTile\.tileId/);
    assert.match(slice, /column:\s*xCh\.field/);
    assert.match(slice, /region,/);
    assert.match(slice, /sourceTileId:\s*dashboardTile\.tileId/);
    assert.match(slice, /filters:\s*dashboardFilters/);
  });

  it("only dispatches when the constructor returns a non-null region (defensive)", () => {
    // makeTemporalRegion / makeCategoricalRegion return null for
    // zero-width / empty brushes — the dispatch is guarded so a
    // malformed event never fires.
    assert.match(lineSrc, /if\s*\(\s*region\s*\)\s*\{\s*\n[\s\S]*?dispatchExplainSlice/);
  });
});

describe("WI4-wiring-trend · ref cleanup across all brushUp paths", () => {
  it("resets brushExplainRef.current = false after the click-path dispatch", () => {
    // The click path (< BRUSH_MIN_PX) resets both refs so a
    // subsequent plain brushDown doesn't inherit a stale alt flag
    // from a no-op click.
    const clickResetIdx = lineSrc.indexOf("brushModifierRef.current = false;");
    assert.ok(clickResetIdx > 0, "brushModifierRef reset present");
    const slice = lineSrc.slice(clickResetIdx, clickResetIdx + 200);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
  });

  it("resets brushExplainRef.current = false after the explain-slice dispatch", () => {
    // The explain path resets both refs so a subsequent plain
    // drag's brushDown overwrites them cleanly.
    const dispatchIdx = lineSrc.indexOf("dispatchExplainSlice({");
    const slice = lineSrc.slice(dispatchIdx, dispatchIdx + 600);
    assert.match(slice, /brushExplainRef\.current\s*=\s*false\s*;/);
    assert.match(slice, /brushModifierRef\.current\s*=\s*false\s*;/);
  });
});

describe("WI4-wiring-trend · pre-existing brush-to-zoom behaviour preserved", () => {
  it("keeps the temporal-zoom setZoomRange branch intact (plain drag)", () => {
    // The pre-existing zoom path (setZoomRange on temporal axis)
    // remains untouched — alt-drag is the new intent, plain drag
    // is unchanged.
    assert.match(
      lineSrc,
      /setZoomRange\(\[\s*newMin\s*,\s*newMax\s*\]\)/,
    );
  });

  it("keeps the categorical-zoom setZoomRange branch intact (plain drag)", () => {
    // The categorical zoom path uses index bounds — unchanged.
    assert.match(lineSrc, /setZoomRange\(\[\s*i0\s*,\s*i1\s*\]\)/);
  });

  it("keeps the WD3 drill-through dispatch on the click path (cmd/ctrl + tiny drag)", () => {
    // WD3 wiring stays intact — alt-drag and cmd-click are mutually
    // exclusive in practice (different distance regimes), but the
    // negative pin ensures the prior wave's wiring isn't accidentally
    // removed.
    assert.match(
      lineSrc,
      /if\s*\(\s*brushModifierRef\.current\s*\)\s*\{\s*\n\s*dispatchDrillThrough\(\{/,
    );
  });
});

describe("WI4-wiring-trend · wave marker present", () => {
  it("includes the WI4-wiring-trend wave marker in the file (greppable lineage)", () => {
    // The marker lets future-Claude grep for the wave's wiring
    // surface; mirrors the WD3-wiring-rest-trend marker shape.
    assert.match(lineSrc, /Wave\s*WI4-wiring-trend/);
  });
});
