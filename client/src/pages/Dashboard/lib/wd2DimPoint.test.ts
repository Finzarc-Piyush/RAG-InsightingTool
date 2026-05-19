/**
 * Wave WD2-dim-point · source-inspection tests for the PointRenderer
 * dim-non-matching-marks wiring. Closes the WD2-dim-* family for every
 * visx renderer with a categorical filter target.
 *
 * PointRenderer diverges from WD2-dim-trend's per-series shape:
 * scatter marks are individually filter-targetable (each point's
 * dispatch carries its own `rawColor` — WD2-wiring-rest-point's
 * dispatch is per-point), so the dim contract is also per-point. A
 * single `dimMul` is lifted once per point so the fill (`0.7 * op`)
 * and the stroke (`op`) consume the same factor — keeps a dimmed
 * point visually coherent (the fill and the ring fade together; a
 * dimmed fill with a non-dimmed ring would render as a faded dot
 * with a stark outline).
 *
 * The dim is gated on `colorCh` AND on `dashboardTile` being present
 * — pure quantitative scatters (no color encoding) and chat/explorer
 * scatters have nothing to dim against. Same applicability domain as
 * the existing `crossFilterReady` dispatch gate.
 *
 * Tests pin: the new `isCrossFilterActive` import alongside
 * `dispatchCrossFilter` + `toFilterValue`, the lifted dim triplet
 * (`dashboardFilters` / `colorFilterSel` / `dashboardDimActive`)
 * with its colorCh AND-gate, the per-point `isDashboardDimmed` +
 * `dimMul` composition, and the opacity mutation on both render
 * branches (glyph `<path>` for shape-encoded scatter and `<Circle>`
 * for the plain case).
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

describe("WD2-dim-point · PointRenderer imports isCrossFilterActive alongside dispatchCrossFilter + toFilterValue", () => {
  it("named-imports isCrossFilterActive from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      pointSrc,
      /import \{[\s\S]*?dispatchCrossFilter,[\s\S]*?isCrossFilterActive,[\s\S]*?toFilterValue,[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });
});

describe("WD2-dim-point · dashboardDimActive lifted once per render, gated on colorCh", () => {
  it("reads filters off dashboardTile?.filters once at the top of the body", () => {
    assert.match(
      pointSrc,
      /const dashboardFilters = dashboardTile\?\.filters;/,
    );
  });

  it("selects the color-field filter selection only when colorCh exists", () => {
    // Gating the lookup on colorCh keeps the access path safe in the
    // pure-quantitative scatter case where `colorCh` is null — the
    // ternary collapses to `undefined` so dashboardDimActive falls
    // through to false without ever dereferencing `null.field`.
    assert.match(
      pointSrc,
      /const colorFilterSel = colorCh\s*\?\s*dashboardFilters\?\.\[colorCh\.field\]\s*:\s*undefined;/,
    );
  });

  it("dashboardDimActive AND-gates on !!colorCh (so single-encoding scatters skip dim entirely)", () => {
    // Four guards are load-bearing: colorCh exists (otherwise no
    // categorical field to filter), selection exists (otherwise nothing
    // brushed), selection is categorical (date / numeric range cannot
    // encode a discrete value), and the values array is non-empty (so
    // re-clearing the last value reverts every point to full opacity).
    assert.match(
      pointSrc,
      /const dashboardDimActive =\s*!!colorCh &&\s*!!colorFilterSel &&\s*colorFilterSel\.type === "categorical" &&\s*colorFilterSel\.values\.length > 0;/,
    );
  });

  it("the lifted locals live in the function body, NOT inside points.map (so the categorical-selection lookup runs once per render not per point)", () => {
    const liftIdx = pointSrc.indexOf("const dashboardDimActive =");
    const mapIdx = pointSrc.indexOf("{points.map((p) => {");
    assert.ok(liftIdx >= 0 && mapIdx >= 0);
    assert.ok(
      liftIdx < mapIdx,
      "dashboardDimActive must be lifted ABOVE the points.map JSX body",
    );
  });

  it("the lifted dim triplet sits adjacent to the existing crossFilterReady gate (shared applicability domain)", () => {
    // Dispatch and dim share the exact same opt-in conditions (a
    // dashboardTile is mounted AND a colorCh exists). Keeping them
    // co-located makes the relationship discoverable for a future
    // renderer wave.
    const readyIdx = pointSrc.indexOf("const crossFilterReady = !!dashboardTile && !!colorCh;");
    const liftIdx = pointSrc.indexOf("const dashboardFilters = dashboardTile?.filters;");
    assert.ok(readyIdx >= 0 && liftIdx >= 0);
    assert.ok(
      liftIdx > readyIdx && liftIdx - readyIdx < 1500,
      "dim triplet must sit shortly after crossFilterReady",
    );
  });
});

describe("WD2-dim-point · per-point isDashboardDimmed + dimMul lifting", () => {
  it("isDashboardDimmed AND-gates on dashboardDimActive AND !isCrossFilterActive(filters, colorCh.field, p.rawColor)", () => {
    // Non-null assertion on colorCh inside the map is safe because
    // dashboardDimActive is true only when colorCh is truthy. Passing
    // p.rawColor (not p.colorKey) is load-bearing for non-string color
    // dims — Date / numeric / boolean values produce different strings
    // via asString vs. toFilterValue, so matching against the raw form
    // is the only correct comparison.
    assert.match(
      pointSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*colorCh!\.field,\s*p\.rawColor,\s*\);/,
    );
  });

  it("passes p.rawColor directly (NOT toFilterValue(p.rawColor)) — isCrossFilterActive does the coercion internally", () => {
    // Pin against a future refactor that double-coerces. The signature
    // accepts `unknown` (widened in WD2-dim-bar) and the body calls
    // toFilterValue(value) once. Passing the already-coerced string
    // would still work but creates redundant surface area.
    const callIdx = pointSrc.indexOf("isCrossFilterActive(");
    assert.ok(callIdx >= 0, "isCrossFilterActive must be called");
    const callArgs = pointSrc.slice(callIdx, callIdx + 200);
    assert.doesNotMatch(callArgs, /toFilterValue\(/);
  });

  it("lifts a single dimMul local so the fill AND the stroke both consume the same factor per point", () => {
    // One per-point dimMul shared between fillOpacity and strokeOpacity
    // keeps a dimmed point visually coherent: a dimmed fill with a
    // non-dimmed ring would render as a faded dot with a stark
    // outline. Mirrors WD2-dim-area's per-series dimMul shape.
    assert.match(
      pointSrc,
      /const dimMul = isDashboardDimmed \? 0\.4 : 1;/,
    );
  });

  it("uses 0.4 as the dim factor (consistent with WD2-dim-bar / -cat / -rect / -trend)", () => {
    // All WD2-dim-* renderers settle on 0.4. A future visual-design
    // wave can change the factor in one place if needed; consistency
    // across renderers matters for a multi-tile dashboard.
    const dimAssignIdx = pointSrc.indexOf("const dimMul = isDashboardDimmed");
    assert.ok(dimAssignIdx >= 0);
    const slice = pointSrc.slice(dimAssignIdx, dimAssignIdx + 80);
    assert.match(slice, /\?\s*0\.4\s*:\s*1/);
  });

  it("the per-point lifting lives inside points.map (NOT inside any branching JSX)", () => {
    // isDashboardDimmed + dimMul must be computed before the
    // shapeCh-branching `if` so both render branches see the same
    // values. Pin position relative to the cx / cy lifting.
    const cxIdx = pointSrc.indexOf("const cx = xScale(p.x) ?? 0;");
    const dimIdx = pointSrc.indexOf("const isDashboardDimmed =\n");
    const ifShapeIdx = pointSrc.indexOf("if (shapeCh) {");
    assert.ok(cxIdx >= 0 && dimIdx >= 0 && ifShapeIdx >= 0);
    assert.ok(
      cxIdx < dimIdx && dimIdx < ifShapeIdx,
      "isDashboardDimmed must be computed AFTER cx/cy lifting but BEFORE the shapeCh branching",
    );
  });
});

describe("WD2-dim-point · glyph <path> branch composes dimMul into both opacities", () => {
  it("glyph <path> fillOpacity composes 0.7 * op * dimMul (preserves baseline 0.7 + legend op)", () => {
    // The pre-wave shape was `fillOpacity={0.7 * op}`. The dim factor
    // multiplies on top so a legend-hidden point at op === 0 still
    // renders nothing and a dimmed point at op === 1 renders at
    // 0.7 * 1 * 0.4 = 0.28.
    assert.match(
      pointSrc,
      /<path[\s\S]{0,400}fillOpacity=\{0\.7 \* op \* dimMul\}/,
    );
  });

  it("glyph <path> strokeOpacity composes op * dimMul (preserves legend op)", () => {
    assert.match(
      pointSrc,
      /<path[\s\S]{0,400}strokeOpacity=\{op \* dimMul\}/,
    );
  });
});

describe("WD2-dim-point · plain <Circle> branch composes dimMul into both opacities", () => {
  it("plain <Circle> fillOpacity composes 0.7 * op * dimMul", () => {
    assert.match(
      pointSrc,
      /<Circle[\s\S]{0,400}fillOpacity=\{0\.7 \* op \* dimMul\}/,
    );
  });

  it("plain <Circle> strokeOpacity composes op * dimMul", () => {
    assert.match(
      pointSrc,
      /<Circle[\s\S]{0,400}strokeOpacity=\{op \* dimMul\}/,
    );
  });

  it("does NOT add an outline (stroke / strokeWidth) for dashboard-matching points — purely opacity-based", () => {
    // Same opacity-only contract as WD2-dim-bar / -cat / -rect /
    // -trend. Outlining matching marks on every tile of a multi-tile
    // dashboard would be visually noisy.
    assert.doesNotMatch(
      pointSrc,
      /isDashboardDimmed\s*\?\s*"hsl\(var\(--foreground\)\)"/,
    );
    assert.doesNotMatch(
      pointSrc,
      /strokeWidth=\{isDashboardDimmed/,
    );
  });
});

describe("WD2-dim-point · documentation comment names the per-point divergence from WD2-dim-trend", () => {
  it("the lifted locals comment cites WD2-dim-point + names the per-point shape divergence from per-series trends", () => {
    // Documentation comment is load-bearing for future Claude: names
    // why scatter dims per-point while line/area dim per-series, so a
    // future renderer wave doesn't try to consolidate them.
    const idx = pointSrc.indexOf("WD2-dim-point");
    assert.ok(idx >= 0, "WD2-dim-point wave marker must be in source");
    const after = pointSrc.slice(idx, idx + 800);
    assert.match(after, /per-point/);
    assert.match(after, /individually filter-targetable/);
  });
});

describe("WD2-dim-point · cross-filter dispatch and dim share applicability domain", () => {
  it("crossFilterReady gate retained (dispatch unchanged by this wave)", () => {
    // The pre-existing dispatch gate stays exactly as it was. WD2-dim-point
    // only adds the dim factor; the click-to-filter behaviour is
    // unchanged. Pin against a future refactor that conflates the two.
    assert.match(
      pointSrc,
      /const crossFilterReady = !!dashboardTile && !!colorCh;/,
    );
  });

  it("dim and dispatch gates use the same two predicates (!!dashboardTile && !!colorCh)", () => {
    // crossFilterReady AND-gates on both. dashboardDimActive
    // AND-gates on !!colorCh AND the selection guards, which is
    // strictly tighter (a mounted dashboardTile without an active
    // selection still allows clicks to dispatch, but nothing dims).
    // The shared `!!colorCh` half is the load-bearing applicability
    // pin: a chart that has no colorCh has nothing for dispatch OR
    // dim to act on.
    const readyIdx = pointSrc.indexOf("const crossFilterReady = !!dashboardTile && !!colorCh;");
    assert.ok(readyIdx >= 0);
    const dimGateIdx = pointSrc.indexOf("!!colorCh &&\n");
    assert.ok(dimGateIdx > readyIdx);
  });
});
