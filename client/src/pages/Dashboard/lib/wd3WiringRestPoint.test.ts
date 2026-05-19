/**
 * Wave WD3-wiring-rest-point · source-inspection tests for
 * PointRenderer (scatter / bubble) drill-through wiring.
 *
 * PointRenderer's WD3 wiring follows the WD3-wiring-rest-cat single-
 * event-handler shape because its onClick already lives at the per-
 * mark level (the WD2 design). The conditional
 * `crossFilterReady ? () => ... : undefined` shape from WD2 widens to
 * `crossFilterReady ? (e: React.MouseEvent<SVGElement>) => ... :
 * undefined` so the modifier check can read `metaKey` / `ctrlKey`.
 *
 * Tests pin: import shape; the conditional `crossFilterReady` gate is
 * preserved (pure quant scatters with no colorCh DON'T drill either —
 * the two opt-in domains are identical); the modifier branch fires
 * BEFORE dispatchCrossFilter; payload carries chartId / column / value
 * (raw — NOT toFilterValue-coerced) / sourceTileId / filters; plain
 * click still dispatches the WD2 cross-filter with toFilterValue;
 * cross-cutting column-symmetry (drill + cross-filter + dim all on
 * colorCh.field — PointRenderer's per-mark filter target); drill
 * dispatch count = 1; WD3-wiring-rest-point marker present.
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

describe("WD3-wiring-rest-point · PointRenderer imports the drillThrough helpers", () => {
  it("named-imports isModifierClick + dispatchDrillThrough from @/pages/Dashboard/lib/drillThrough", () => {
    assert.match(
      pointSrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("keeps the WD2 crossFilter imports untouched (additive change — dispatchCrossFilter + isCrossFilterActive + toFilterValue)", () => {
    assert.match(
      pointSrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

describe("WD3-wiring-rest-point · onClick widens to receive a MouseEvent for modifier inspection", () => {
  it("the onPointClick handler now accepts a `React.MouseEvent<SVGElement>` (widened from parameterless)", () => {
    assert.match(
      pointSrc,
      /const onPointClick = crossFilterReady\s*\?\s*\(e: React\.MouseEvent<SVGElement>\) => \{/,
    );
  });

  it("the conditional `crossFilterReady ? ... : undefined` shape is preserved (the WD2 gate)", () => {
    // The WD2 gate is the load-bearing decision for both waves: pure
    // quant scatters with no colorCh have no drill target either — the
    // two opt-in domains are identical. The conditional MUST stay so
    // that pure-quant scatters DON'T accidentally fire drill on cmd-
    // click (no colorCh → no column to drill on).
    assert.match(
      pointSrc,
      /const onPointClick = crossFilterReady[\s\S]*?: undefined;/,
    );
  });
});

describe("WD3-wiring-rest-point · onClick gains the inline modifier-key branch", () => {
  it("the modifier branch fires INSIDE the onPointClick body, BEFORE dispatchCrossFilter", () => {
    // Pin the structural ordering: isModifierClick branch + return
    // come FIRST; the WD2 cross-filter dispatch follows. A refactor
    // that reverses the order would double-fire on cmd-click.
    assert.match(
      pointSrc,
      /\(e: React\.MouseEvent<SVGElement>\) => \{[\s\S]*?if \(isModifierClick\(e\)\) \{[\s\S]*?dispatchDrillThrough\(\{[\s\S]*?\}\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?dispatchCrossFilter\(/,
    );
  });

  it("dispatchDrillThrough payload carries chartId / column / value (raw) / sourceTileId / filters", () => {
    assert.match(
      pointSrc,
      /dispatchDrillThrough\(\{\s*chartId: dashboardTile!\.tileId,\s*column: colorCh!\.field,\s*value: p\.rawColor,\s*sourceTileId: dashboardTile!\.tileId,\s*filters: dashboardFilters,?\s*\}\);/,
    );
  });

  it("drill value passed RAW (p.rawColor) — NOT toFilterValue-coerced", () => {
    // The server-side canonicaliser picks Date / number / categorical
    // comparison per the inferred column type. Coercing client-side
    // would lose type information.
    const drillBlock = pointSrc.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "PointRenderer must contain a dispatchDrillThrough block");
    assert.doesNotMatch(drillBlock, /value: toFilterValue\(/);
  });

  it("the `return;` after dispatch is present — single-intent enforcement", () => {
    // Without the return, a cmd-click would fire BOTH drill-through
    // AND cross-filter, doubling the user's intent.
    assert.match(
      pointSrc,
      /dispatchDrillThrough\(\{[\s\S]*?\}\);\s*return;/,
    );
  });

  it("plain-click (no modifier) still dispatches cross-filter with toFilterValue-coerced value (WD2 contract preserved)", () => {
    // Regression-pin: the WD2 dispatch path is untouched. A future
    // refactor that accidentally drops the cross-filter dispatch
    // would break the categorical filter UX.
    assert.match(
      pointSrc,
      /dispatchCrossFilter\(\{\s*column: colorCh!\.field,\s*value: toFilterValue\(p\.rawColor\),\s*sourceTileId: dashboardTile!\.tileId,?\s*\}\);/,
    );
  });
});

describe("WD3-wiring-rest-point · cursorStyle gate stays on `crossFilterReady`", () => {
  it("cursorStyle remains gated on `crossFilterReady` — drill-through doesn't widen the cursor domain", () => {
    // The cursor:pointer affordance signals "clickable" — both cross-
    // filter and drill share the affordance, so the gate is the
    // ALREADY-correct `crossFilterReady`. A cmd-down keydown listener
    // that changes cursor to "zoom-in" is a separate polish wave
    // (carried in dormancy-debt).
    assert.match(
      pointSrc,
      /const cursorStyle = crossFilterReady\s*\?\s*\{\s*cursor:\s*"pointer" as const\s*\}\s*:\s*undefined;/,
    );
  });
});

describe("WD3-wiring-rest-point · WD2-dim + WD2-wiring contracts preserved", () => {
  it("WD2-dim-point per-point dim factor (dashboardDimActive + dimMul) is still applied", () => {
    // Additive change — the dim factor must continue to compose with
    // fillOpacity / strokeOpacity. A refactor that broke this would
    // visually de-couple cross-filter feedback from the dispatch.
    assert.match(
      pointSrc,
      /const isDashboardDimmed =[\s\S]*?dashboardDimActive &&[\s\S]*?!isCrossFilterActive\(/,
    );
    assert.match(pointSrc, /const dimMul = isDashboardDimmed \? 0\.4 : 1;/);
  });

  it("the <Circle> + <path> render paths still bind `onClick={onPointClick}` (additive change preserves both branches)", () => {
    assert.match(pointSrc, /<Circle[\s\S]*?onClick=\{onPointClick\}/);
    assert.match(pointSrc, /<path[\s\S]*?onClick=\{onPointClick\}/);
  });
});

describe("WD3-wiring-rest-point · cross-cutting contracts", () => {
  it("the renderer carries the WD3-wiring-rest-point marker", () => {
    assert.match(pointSrc, /WD3-wiring-rest-point/);
  });

  it("drill column matches the WD2 cross-filter dispatch column (colorCh!.field) — column-symmetry", () => {
    // Drift between drill and cross-filter columns would produce a
    // "drill on a column you can't filter" UX mismatch. PointRenderer
    // is unique in keying on colorCh (not xCh) because its per-mark
    // filter target is the color group, not the quantitative x axis.
    assert.match(
      pointSrc,
      /dispatchDrillThrough\(\{[\s\S]*?column: colorCh!\.field,/,
    );
    assert.match(
      pointSrc,
      /dispatchCrossFilter\(\{\s*column: colorCh!\.field,/,
    );
  });

  it("WD2-dim concern keys on the SAME colorCh.field (drill + dispatch + dim symmetry)", () => {
    // The WD2-dim-point check matches `rawColor` against the
    // categorical filter on `colorCh!.field`. Pinning here ensures all
    // three concerns stay key-symmetric.
    assert.match(
      pointSrc,
      /isCrossFilterActive\(\s*dashboardFilters!,\s*colorCh!\.field,\s*p\.rawColor,?\s*\)/,
    );
  });

  it("drill dispatch count is exactly 1 (per-renderer single-shot)", () => {
    // One per-mark onClick → one drill dispatch. Pin the count so a
    // refactor that adds a second dispatch surface (e.g. legend cmd-
    // click) is intentional.
    const drillCount = (pointSrc.match(/dispatchDrillThrough\(/g) ?? []).length;
    assert.equal(
      drillCount,
      1,
      `PointRenderer expected 1 drill dispatch, found ${drillCount}`,
    );
  });
});
