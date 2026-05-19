/**
 * Wave WD2-dim-trend · source-inspection tests for the Line + Area
 * renderer dim shapes. Trend renderers have continuous-x marks (lines
 * and stacked areas) so there's no per-point categorical brush
 * target. The natural dim concept is per-SERIES: when an active
 * categorical cross-filter on `colorCh.field` doesn't include a
 * series's rawColor, the series's stroke / fill opacities multiply
 * by 0.4. Single-series trends (no colorCh) have no color field to
 * filter against, so the dim factor is gated on colorCh — same
 * pattern as WD2-wiring-rest-point's dispatch gating.
 *
 * Both renderers extend their Series interface with `rawColor?:
 * unknown` (preserved alongside the stringified `key`) so the dim
 * check can call `isCrossFilterActive` with the same shape WD2
 * cross-filter events recorded. Without rawColor preservation, the
 * stringified key would miss for non-string color dims (Date /
 * number / boolean values stringify differently via `asString` vs.
 * `toFilterValue`).
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

// ── shared helpers ─────────────────────────────────────────────────

const assertImportsIsCrossFilterActive = (src: string, label: string) => {
  assert.match(
    src,
    /import \{[\s\S]*?isCrossFilterActive[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    `${label} must import isCrossFilterActive`,
  );
};

const assertSeriesHasRawColor = (src: string, label: string) => {
  // Series interface must expose rawColor?: unknown for the dim check.
  assert.match(
    src,
    /interface Series \{[\s\S]*?rawColor\?: unknown;[\s\S]*?\}/,
    `${label}.Series must include rawColor?: unknown`,
  );
};

const assertLiftedDimActive = (src: string, label: string) => {
  // dashboardFilters + colorFilterSel + dashboardDimActive triplet,
  // gated on colorCh (the dim only applies when colorCh exists).
  assert.match(
    src,
    /const dashboardFilters = dashboardTile\?\.filters;/,
    `${label} must lift dashboardFilters`,
  );
  assert.match(
    src,
    /const colorFilterSel = colorCh\s*\?\s*dashboardFilters\?\.\[colorCh\.field\]\s*:\s*undefined;/,
    `${label} must read colorFilterSel only when colorCh exists`,
  );
  assert.match(
    src,
    /const dashboardDimActive =\s*!!colorCh &&\s*!!colorFilterSel &&\s*colorFilterSel\.type === "categorical" &&\s*colorFilterSel\.values\.length > 0;/,
    `${label} must gate dashboardDimActive on colorCh`,
  );
};

// ── LineRenderer ──────────────────────────────────────────────────

describe("WD2-dim-trend · LineRenderer imports + Series shape", () => {
  it("named-imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(lineSrc, "LineRenderer");
  });

  it("extends Series with rawColor?: unknown", () => {
    assertSeriesHasRawColor(lineSrc, "LineRenderer");
  });

  it("colorCh group builder preserves the type-original color value", () => {
    // Each group's first occurrence captures rawColor; subsequent points
    // for the same color key push into the existing group.
    assert.match(
      lineSrc,
      /const rawColor = colorCh\.accessor\(r\);[\s\S]*?const k = asString\(rawColor\);/,
    );
    assert.match(
      lineSrc,
      /groups\.set\(k, \{[\s\S]*?points: \[[\s\S]*?\],[\s\S]*?rawColor,[\s\S]*?\}\);/,
    );
  });

  it("Array.from(groups.entries()).map returns objects carrying agg.rawColor on each Series", () => {
    assert.match(
      lineSrc,
      /return Array\.from\(groups\.entries\(\)\)\.map\(\(\[key, agg\]\) => \(\{[\s\S]*?rawColor: agg\.rawColor,[\s\S]*?\}\)\)/,
    );
  });
});

describe("WD2-dim-trend · LineRenderer per-series dim", () => {
  it("lifts dashboardDimActive on colorCh.field, gated on colorCh existing", () => {
    assertLiftedDimActive(lineSrc, "LineRenderer");
  });

  it("per-series isDashboardDimmed checks isCrossFilterActive against s.rawColor on colorCh!.field", () => {
    // Non-null assertion on colorCh inside the map is safe because
    // dashboardDimActive is true only when colorCh is truthy.
    assert.match(
      lineSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*colorCh!\.field,\s*s\.rawColor,\s*\);/,
    );
  });

  it("LinePath strokeOpacity composes op * (isDashboardDimmed ? 0.4 : 1) (preserves legend op)", () => {
    // The existing seriesOpacity legend factor (`op`) stays intact;
    // the dim factor multiplies on top, so a legend-hidden series at
    // op === 0 still renders nothing and a dimmed series at op === 1
    // renders at 0.4.
    assert.match(
      lineSrc,
      /<LinePath[\s\S]{0,400}strokeOpacity=\{op \* \(isDashboardDimmed \? 0\.4 : 1\)\}/,
    );
  });
});

// ── AreaRenderer ──────────────────────────────────────────────────

describe("WD2-dim-trend · AreaRenderer imports + Series shape", () => {
  it("named-imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(areaSrc, "AreaRenderer");
  });

  it("extends Series with rawColor?: unknown", () => {
    assertSeriesHasRawColor(areaSrc, "AreaRenderer");
  });

  it("colorCh group builder preserves the type-original color value", () => {
    assert.match(
      areaSrc,
      /const rawColor = colorCh\.accessor\(r\);[\s\S]*?const k = asString\(rawColor\);/,
    );
    assert.match(
      areaSrc,
      /groups\.set\(k, \{[\s\S]*?points: \[[\s\S]*?\],[\s\S]*?rawColor,[\s\S]*?\}\);/,
    );
  });

  it("Array.from(groups.entries()).map returns objects carrying agg.rawColor on each Series", () => {
    assert.match(
      areaSrc,
      /return Array\.from\(groups\.entries\(\)\)\.map\(\(\[key, agg\]\) => \(\{[\s\S]*?rawColor: agg\.rawColor,[\s\S]*?\}\)\)/,
    );
  });
});

describe("WD2-dim-trend · AreaRenderer per-series dim (AreaClosed + LinePath both dim)", () => {
  it("lifts dashboardDimActive on colorCh.field, gated on colorCh existing", () => {
    assertLiftedDimActive(areaSrc, "AreaRenderer");
  });

  it("per-series isDashboardDimmed checks isCrossFilterActive against s.rawColor on colorCh!.field", () => {
    assert.match(
      areaSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*colorCh!\.field,\s*s\.rawColor,\s*\);/,
    );
  });

  it("lifts a single dimMul local so the AreaClosed fill AND the LinePath stroke both consume the same factor", () => {
    // A single dimMul shared between the area fill and the line stroke
    // keeps them visually coherent: a dimmed fill with a non-dimmed
    // border would render as a faded area with a stark outline.
    assert.match(
      areaSrc,
      /const dimMul = isDashboardDimmed \? 0\.4 : 1;/,
    );
  });

  it("AreaClosed fillOpacity composes 0.55 * op * dimMul (preserves baseline 0.55 + legend op)", () => {
    assert.match(
      areaSrc,
      /<AreaClosed[\s\S]{0,400}fillOpacity=\{0\.55 \* op \* dimMul\}/,
    );
  });

  it("LinePath strokeOpacity composes op * dimMul (preserves legend op)", () => {
    assert.match(
      areaSrc,
      /<LinePath[\s\S]{0,400}strokeOpacity=\{op \* dimMul\}/,
    );
  });

  it("stacked memo preserves rawColor on each series via spread", () => {
    // The stacked transformation must NOT drop rawColor when projecting
    // through the unified x domain. Spread (`{ ...s, points: stackedPoints }`)
    // is the safe pattern.
    assert.match(
      areaSrc,
      /out\.push\(\{ \.\.\.s, points: stackedPoints \}\);/,
    );
  });
});

// ── cross-cutting: gating on colorCh ───────────────────────────────

describe("WD2-dim-trend · colorCh-gating (single-series trends do not dim)", () => {
  it("LineRenderer's dashboardDimActive AND-gates on !!colorCh so single-series trends skip dim entirely", () => {
    // The triple-gate ensures `dashboardDimActive === false` whenever
    // colorCh is null, so the non-null assertion `colorCh!.field`
    // inside the map is only reachable when colorCh is truthy.
    assert.match(lineSrc, /!!colorCh &&[\s\S]*?!!colorFilterSel/);
  });

  it("AreaRenderer's dashboardDimActive AND-gates on !!colorCh", () => {
    assert.match(areaSrc, /!!colorCh &&[\s\S]*?!!colorFilterSel/);
  });
});
