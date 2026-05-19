/**
 * Wave WD2-dim-cat · source-inspection tests for the 5 categorical-
 * by-construction visx renderers (Arc / Funnel / Box / Waterfall /
 * Combo). Fans out the WD2-dim-bar pattern from `BarRenderer.tsx`:
 * each renderer reads `dashboardTile?.filters` via
 * `useDashboardTileContext()`, lifts a shared `dashboardDimActive`
 * local once per render (categorical x-field selection exists +
 * `values.length > 0`), and applies a `* 0.4` factor on its mark's
 * existing `fillOpacity` whenever an active categorical filter on
 * the renderer's primary x-field doesn't include the mark's raw
 * value. The dispatch wiring from WD2-wiring-rest-cat stays
 * untouched.
 *
 * Per-renderer pins:
 *   - ArcRenderer slices read `labelCh.field` (the categorical
 *     dimension for a pie / donut) and check `arc.data.rawKey`.
 *   - FunnelRenderer rects read `enc.x.field` and check `s.rawLabel`.
 *   - BoxRenderer box-rects read `enc.x.field` and check `s.rawCategory`;
 *     whiskers + median line stay full opacity (structural geometry).
 *   - WaterfallRenderer contribution bars dim on `b.rawCategory`;
 *     running-total bars (`b.isTotal`) are excluded from dim (same
 *     exclusion as the dispatch path).
 *   - ComboRenderer bars (NOT the secondary-axis line) dim on `rawX`
 *     against `xCh.field`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const arcSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/ArcRenderer.tsx"),
  "utf-8",
);
const funnelSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/FunnelRenderer.tsx"),
  "utf-8",
);
const boxSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BoxRenderer.tsx"),
  "utf-8",
);
const waterfallSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/WaterfallRenderer.tsx"),
  "utf-8",
);
const comboSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/ComboRenderer.tsx"),
  "utf-8",
);

// ── shared assertion helpers ────────────────────────────────────────

const assertImportsIsCrossFilterActive = (src: string, label: string) => {
  assert.match(
    src,
    /import \{[\s\S]*?isCrossFilterActive[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    `${label} must import isCrossFilterActive`,
  );
};

const assertLiftedLocals = (
  src: string,
  xFieldExpr: string,
  label: string,
) => {
  // Loose match the dashboardFilters + xFilterSel + dashboardDimActive
  // triplet using the renderer's specific x-field expression.
  assert.match(
    src,
    /const dashboardFilters = dashboardTile\?\.filters;/,
    `${label} must lift dashboardFilters`,
  );
  const xSelRegex = new RegExp(
    `const xFilterSel = dashboardFilters\\?\\.\\[${xFieldExpr.replace(
      /\./g,
      "\\.",
    )}\\];`,
  );
  assert.match(src, xSelRegex, `${label} must read x-filter selection`);
  assert.match(
    src,
    /const dashboardDimActive =\s*!!xFilterSel &&\s*xFilterSel\.type === "categorical" &&\s*xFilterSel\.values\.length > 0;/,
    `${label} must compute dashboardDimActive with full guard`,
  );
};

// ── ArcRenderer (pie / donut slices on labelCh) ────────────────────

describe("WD2-dim-cat · ArcRenderer dims non-matching slices", () => {
  it("imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(arcSrc, "ArcRenderer");
  });

  it("lifts dashboardFilters / xFilterSel (on labelCh.field) / dashboardDimActive", () => {
    assertLiftedLocals(arcSrc, "labelCh.field", "ArcRenderer");
  });

  it("per-slice isDashboardDimmed checks isCrossFilterActive against arc.data.rawKey", () => {
    assert.match(
      arcSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*labelCh\.field,\s*arc\.data\.rawKey,\s*\);/,
    );
  });

  it("path renders fillOpacity={isDashboardDimmed ? 0.4 : 1} (slice had no prior fillOpacity)", () => {
    // Arc slices had no baseline fillOpacity before WD2-dim-cat; the
    // new prop is the pure dim factor with 1 as the default (matched
    // bars stay at full opacity).
    assert.match(
      arcSrc,
      /fillOpacity=\{isDashboardDimmed \? 0\.4 : 1\}/,
    );
  });
});

// ── FunnelRenderer (stage rects on enc.x.field) ────────────────────

describe("WD2-dim-cat · FunnelRenderer dims non-matching stages", () => {
  it("imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(funnelSrc, "FunnelRenderer");
  });

  it("lifts dashboardFilters / xFilterSel (on enc.x.field) / dashboardDimActive", () => {
    assertLiftedLocals(funnelSrc, "enc.x.field", "FunnelRenderer");
  });

  it("per-stage isDashboardDimmed checks isCrossFilterActive against s.rawLabel", () => {
    assert.match(
      funnelSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(dashboardFilters!, enc\.x\.field, s\.rawLabel\);/,
    );
  });

  it("rect fillOpacity composes 0.85 * (isDashboardDimmed ? 0.4 : 1) (preserves baseline 0.85)", () => {
    assert.match(
      funnelSrc,
      /fillOpacity=\{0\.85 \* \(isDashboardDimmed \? 0\.4 : 1\)\}/,
    );
  });
});

// ── BoxRenderer (box rects on enc.x.field) ─────────────────────────

describe("WD2-dim-cat · BoxRenderer dims non-matching boxes (whiskers stay)", () => {
  it("imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(boxSrc, "BoxRenderer");
  });

  it("lifts dashboardFilters / xFilterSel (on enc.x.field) / dashboardDimActive", () => {
    assertLiftedLocals(boxSrc, "enc.x.field", "BoxRenderer");
  });

  it("per-box isDashboardDimmed checks isCrossFilterActive against s.rawCategory", () => {
    assert.match(
      boxSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(dashboardFilters!, enc\.x\.field, s\.rawCategory\);/,
    );
  });

  it("box rect fillOpacity composes 0.4 * (isDashboardDimmed ? 0.4 : 1) (preserves baseline 0.4)", () => {
    assert.match(
      boxSrc,
      /fillOpacity=\{0\.4 \* \(isDashboardDimmed \? 0\.4 : 1\)\}/,
    );
  });

  it("whiskers + median strokes stay unchanged (no isDashboardDimmed wiring on <line stroke=fill> elements)", () => {
    // Structural geometry — dimming whiskers based on category filter
    // would hide the IQR / range distribution information the user
    // needs to compare boxes. The doc comment explicitly names this.
    assert.match(boxSrc, /Whiskers \+ median stroke are\s*\n\s*\/\/ left untouched/);
    assert.doesNotMatch(
      boxSrc,
      /<line[\s\S]{0,200}strokeOpacity=\{[^}]*isDashboardDimmed/,
    );
  });
});

// ── WaterfallRenderer (contribution bars on enc.x.field) ───────────

describe("WD2-dim-cat · WaterfallRenderer dims contribution bars (totals excluded)", () => {
  it("imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(waterfallSrc, "WaterfallRenderer");
  });

  it("lifts dashboardFilters / xFilterSel (on enc.x.field) / dashboardDimActive", () => {
    assertLiftedLocals(waterfallSrc, "enc.x.field", "WaterfallRenderer");
  });

  it("isDashboardDimmed AND-gates on !b.isTotal so running-total bars stay full opacity", () => {
    // Symmetric with the dispatch gate (`clickable = dashboardTile &&
    // !b.isTotal`) — totals are synthetic summary rows, not categorical
    // marks the user can filter to.
    assert.match(
      waterfallSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!b\.isTotal &&\s*!isCrossFilterActive\(dashboardFilters!, enc\.x\.field, b\.rawCategory\);/,
    );
  });

  it("bar fillOpacity composes 0.85 * (isDashboardDimmed ? 0.4 : 1) (preserves baseline 0.85)", () => {
    assert.match(
      waterfallSrc,
      /fillOpacity=\{0\.85 \* \(isDashboardDimmed \? 0\.4 : 1\)\}/,
    );
  });
});

// ── ComboRenderer (bars on xCh.field; line stays inert) ────────────

describe("WD2-dim-cat · ComboRenderer dims bars (secondary line untouched)", () => {
  it("imports isCrossFilterActive", () => {
    assertImportsIsCrossFilterActive(comboSrc, "ComboRenderer");
  });

  it("lifts dashboardFilters / xFilterSel (on xCh.field) / dashboardDimActive", () => {
    assertLiftedLocals(comboSrc, "xCh.field", "ComboRenderer");
  });

  it("per-bar isDashboardDimmed checks isCrossFilterActive against rawX", () => {
    assert.match(
      comboSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(dashboardFilters!, xCh\.field, rawX\);/,
    );
  });

  it("bar fillOpacity composes 0.85 * (isDashboardDimmed ? 0.4 : 1) (preserves baseline 0.85)", () => {
    assert.match(
      comboSrc,
      /fillOpacity=\{0\.85 \* \(isDashboardDimmed \? 0\.4 : 1\)\}/,
    );
  });

  it("no isDashboardDimmed wiring on the <LinePath> secondary-axis line (click-inert + dim-inert)", () => {
    // Dimming a continuous trend line based on a categorical x-filter
    // would break the line's visual coherence (it would render as a
    // gappy interleave of full / dim segments). Doc-comment names this.
    assert.match(
      comboSrc,
      /secondary-axis line is left\s*\n\s*\/\/ untouched/,
    );
    const lineIdx = comboSrc.indexOf("<LinePath");
    assert.ok(lineIdx >= 0);
    const after = comboSrc.slice(lineIdx, lineIdx + 800);
    assert.doesNotMatch(after, /isDashboardDimmed/);
  });
});

// ── cross-cutting: each renderer's lifted locals run once per render

describe("WD2-dim-cat · lifted locals live outside the per-mark map", () => {
  it("ArcRenderer: dashboardDimActive computed BEFORE the pie.arcs.map", () => {
    const lift = arcSrc.indexOf("const dashboardDimActive =");
    const usage = arcSrc.indexOf("pie.arcs.map");
    assert.ok(lift >= 0 && usage >= 0 && lift < usage);
  });

  it("FunnelRenderer: dashboardDimActive computed BEFORE the stages.map", () => {
    const lift = funnelSrc.indexOf("const dashboardDimActive =");
    const usage = funnelSrc.indexOf("stages.map");
    assert.ok(lift >= 0 && usage >= 0 && lift < usage);
  });

  it("BoxRenderer: dashboardDimActive computed BEFORE the stats.map render path", () => {
    const lift = boxSrc.indexOf("const dashboardDimActive =");
    // BoxRenderer iterates over `stats` inside the <Group>; find the
    // first `.map` AFTER the stats memo to ensure the lift comes first.
    const usage = boxSrc.indexOf("stats.map");
    assert.ok(lift >= 0);
    if (usage >= 0) {
      assert.ok(lift < usage);
    }
  });

  it("WaterfallRenderer: dashboardDimActive computed BEFORE the bars.map", () => {
    const lift = waterfallSrc.indexOf("const dashboardDimActive =");
    const usage = waterfallSrc.indexOf("bars.map");
    assert.ok(lift >= 0 && usage >= 0 && lift < usage);
  });

  it("ComboRenderer: dashboardDimActive computed BEFORE the data.map bars", () => {
    const lift = comboSrc.indexOf("const dashboardDimActive =");
    const usage = comboSrc.indexOf("{data.map((row, i)");
    assert.ok(lift >= 0 && usage >= 0 && lift < usage);
  });
});
