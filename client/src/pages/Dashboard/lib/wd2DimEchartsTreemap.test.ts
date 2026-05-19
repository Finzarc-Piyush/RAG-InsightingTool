/**
 * Wave WD2-dim-echarts-treemap · source-inspection tests for the
 * TreemapRenderer + SunburstRenderer dim-non-matching-leaves wiring.
 *
 * ECharts diverges from the visx pack in its dim mechanism: visx
 * renderers post-render mutate per-mark `fillOpacity` / `strokeOpacity`
 * via React JSX props. ECharts mounts its own canvas instance via
 * `EChartsBase` and reads styling from the per-dataItem
 * `itemStyle.opacity` field at series-construction time. The dim
 * factor must therefore be injected inline into the dataItem objects
 * inside the renderer's `tree` memo (not as a post-render React prop).
 *
 * Both renderers share the same dim shape: lift the WD2-dim-bar
 * triplet on `labelCh.field` (the dispatch column from
 * WD2-wiring-echarts); inside the `tree` memo, set `itemStyle:
 * { opacity: 0.4 }` on LEAVES whose `name` isn't in the active
 * categorical filter. Parents stay un-dimmed because they're
 * structural hierarchy (the `groupCh` value, when present) — same
 * carve-out as the WD2-wiring-echarts dispatch (parents don't
 * dispatch; leaves do). The `optionsKey` already serialises `tree`
 * via `JSON.stringify`, so per-leaf `itemStyle` changes propagate
 * through to ECharts's re-render trigger without any additional
 * plumbing.
 *
 * The lifted triplet sits BEFORE the `tree` memo (not after, as in
 * the visx pack) so the memo can consume `dashboardDimActive` +
 * `dashboardFilters` at build time. The memo's dep array is widened
 * to include both so dim-state changes rebuild the tree.
 *
 * Tests pin: the `isCrossFilterActive` import, the widened
 * `TreemapNode` / `SunburstNode` itemStyle types (allowing `opacity`),
 * the lifted dim triplet sitting before the tree memo, the per-leaf
 * `dimLeaf` helper returning `{ opacity: 0.4 }` for non-matching
 * leaves, the inline assignment inside both flat + hierarchical
 * branches, and the widened dep array.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const treemapSrc = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/TreemapRenderer.tsx"),
  "utf-8",
);
const specialtySrc = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/SpecialtyRenderers.tsx"),
  "utf-8",
);

// ── shared helpers ─────────────────────────────────────────────────

const assertImportsIsCrossFilterActive = (src: string, label: string) => {
  assert.match(
    src,
    /import \{[\s\S]*?dispatchCrossFilter,[\s\S]*?isCrossFilterActive,[\s\S]*?toFilterValue,[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    `${label} must import isCrossFilterActive from crossFilter`,
  );
};

const assertLiftedDimTriplet = (src: string, label: string) => {
  assert.match(
    src,
    /const dashboardFilters = dashboardTile\?\.filters;/,
    `${label} must lift dashboardFilters`,
  );
  assert.match(
    src,
    /const labelFilterSel = dashboardFilters\?\.\[labelCh\.field\];/,
    `${label} must read labelFilterSel on labelCh.field`,
  );
  assert.match(
    src,
    /const dashboardDimActive =\s*!!labelFilterSel &&\s*labelFilterSel\.type === "categorical" &&\s*labelFilterSel\.values\.length > 0;/,
    `${label} must compute dashboardDimActive with full categorical guards`,
  );
};

const assertDimLeafHelper = (src: string, nodeType: string, label: string) => {
  // The dimLeaf helper is a local arrow lifted inside the tree memo
  // so both the flat (`!groupCh`) and hierarchical branches share
  // the same composition. Returns `{ opacity: 0.4 }` for non-matching
  // leaves, `undefined` for matching leaves so the caller can spread
  // conditionally (matching leaves get the byte-identical pre-wave
  // shape).
  const helperRe = new RegExp(
    String.raw`const dimLeaf = \(name: string\): ${nodeType}\["itemStyle"\] \| undefined =>\s*` +
      String.raw`dashboardDimActive &&\s*!isCrossFilterActive\(dashboardFilters!, labelCh\.field, name\)\s*` +
      String.raw`\? \{ opacity: 0\.4 \}\s*` +
      String.raw`: undefined;`,
  );
  assert.match(src, helperRe, `${label} must define the dimLeaf helper`);
};

const assertLeafProjection = (src: string, label: string) => {
  // Both flat + hierarchical projections call dimLeaf(name) and
  // conditionally spread the itemStyle. Two occurrences expected:
  // once in the `!groupCh` branch, once in the hierarchical branch.
  const matches = src.match(
    /const itemStyle = dimLeaf\(name\);\s*return itemStyle \? \{ name, value, itemStyle \} : \{ name, value \};/g,
  );
  assert.ok(
    matches && matches.length === 2,
    `${label} must call dimLeaf+spread in both flat AND hierarchical branches (got ${matches?.length ?? 0})`,
  );
};

const assertTreeMemoDeps = (src: string, label: string) => {
  // Dim-state changes (filter toggle in another tile) must trigger
  // the tree memo to rebuild so optionsKey changes and ECharts
  // re-renders. The deps must include both `dashboardDimActive`
  // (for the gate flip) AND `dashboardFilters` (for the membership
  // change without a gate flip — e.g. toggling between two
  // categorical values when the dim is already active).
  assert.match(
    src,
    /\}, \[data, labelCh, valueCh, groupCh, dashboardDimActive, dashboardFilters\]\);/,
    `${label}'s tree memo dep array must include dashboardDimActive + dashboardFilters`,
  );
};

const assertLiftedTripletBeforeTreeMemo = (src: string, label: string) => {
  // Order matters: triplet lifted → tree memo consumes it. If the
  // triplet were lifted AFTER the tree memo, the memo would close
  // over `undefined` on first render.
  const tripletIdx = src.indexOf("const dashboardDimActive =");
  const treeMemoIdx = src.indexOf("const tree = useMemo");
  assert.ok(tripletIdx >= 0 && treeMemoIdx >= 0);
  assert.ok(
    tripletIdx < treeMemoIdx,
    `${label}'s dim triplet must be lifted BEFORE the tree memo`,
  );
};

// ── TreemapRenderer ───────────────────────────────────────────────

describe("WD2-dim-echarts-treemap · TreemapRenderer import + node-type widening", () => {
  it("named-imports isCrossFilterActive alongside dispatchCrossFilter + toFilterValue", () => {
    assertImportsIsCrossFilterActive(treemapSrc, "TreemapRenderer");
  });

  it("widens TreemapNode.itemStyle to allow opacity?: number", () => {
    // The pre-wave shape was `{ color?: string }`. The widening
    // (intersection with `{ opacity?: number }`) is the minimum
    // change that lets per-dataItem dim factors live inline. Inline
    // styles are the only mechanism ECharts exposes for per-dataItem
    // opacity overrides without a custom renderer.
    assert.match(
      treemapSrc,
      /itemStyle\?: \{ color\?: string; opacity\?: number \};/,
    );
  });
});

describe("WD2-dim-echarts-treemap · TreemapRenderer dim triplet", () => {
  it("lifts dashboardFilters / labelFilterSel / dashboardDimActive on labelCh.field", () => {
    assertLiftedDimTriplet(treemapSrc, "TreemapRenderer");
  });

  it("dim triplet sits BEFORE the tree memo so the memo can consume it", () => {
    assertLiftedTripletBeforeTreeMemo(treemapSrc, "TreemapRenderer");
  });

  it("dim triplet sits AFTER the onChartClick useCallback (dispatch then dim, mirroring code-locality of WD2-wiring + WD2-dim pair)", () => {
    // Co-locality with the WD2-wiring-echarts onChartClick keeps
    // dispatch + dim discoverable as a pair (same pattern as
    // WD2-dim-point's adjacency to crossFilterReady).
    const dispatchIdx = treemapSrc.indexOf("const onChartClick = useCallback");
    const dimIdx = treemapSrc.indexOf("const dashboardFilters = dashboardTile?.filters;");
    assert.ok(dispatchIdx >= 0 && dimIdx >= 0);
    assert.ok(
      dispatchIdx < dimIdx,
      "dim triplet must follow onChartClick (dispatch defined first)",
    );
  });
});

describe("WD2-dim-echarts-treemap · TreemapRenderer dimLeaf helper + tree-memo wiring", () => {
  it("defines the dimLeaf helper inside the tree memo returning { opacity: 0.4 } for non-matching leaves", () => {
    assertDimLeafHelper(treemapSrc, "TreemapNode", "TreemapRenderer");
  });

  it("dimLeaf is called in BOTH the flat (!groupCh) and hierarchical branches", () => {
    assertLeafProjection(treemapSrc, "TreemapRenderer");
  });

  it("conditional spread (itemStyle ? {…itemStyle} : {…}) preserves byte-identical pre-wave shape for matching leaves", () => {
    // The pre-wave projection emitted `{ name, value }`. Matching
    // leaves still emit exactly that shape — the conditional spread
    // is the load-bearing pattern that keeps the JSON.stringify
    // serialisation identical across dim-on / dim-off when no
    // filter is active (so the optionsKey doesn't churn on a no-op
    // dim transition).
    const callCount = (treemapSrc.match(/\{ name, value \};/g) ?? []).length;
    assert.ok(callCount >= 2, "matching-leaf shape must appear in both branches");
  });

  it("tree memo dep array includes dashboardDimActive + dashboardFilters", () => {
    assertTreeMemoDeps(treemapSrc, "TreemapRenderer");
  });
});

// ── SunburstRenderer ───────────────────────────────────────────────

describe("WD2-dim-echarts-treemap · SunburstRenderer import + node-type widening", () => {
  it("named-imports isCrossFilterActive alongside dispatchCrossFilter + toFilterValue", () => {
    assertImportsIsCrossFilterActive(specialtySrc, "SunburstRenderer");
  });

  it("widens SunburstNode with itemStyle?: { opacity?: number }", () => {
    // Sunburst's pre-wave SunburstNode had no `itemStyle` at all —
    // the wave introduces the field cleanly so the dim factor has a
    // place to live without retrofitting onto a wider color shape.
    assert.match(
      specialtySrc,
      /interface SunburstNode \{[\s\S]*?itemStyle\?: \{ opacity\?: number \};[\s\S]*?\}/,
    );
  });
});

describe("WD2-dim-echarts-treemap · SunburstRenderer dim triplet", () => {
  it("lifts dashboardFilters / labelFilterSel / dashboardDimActive on labelCh.field", () => {
    assertLiftedDimTriplet(specialtySrc, "SunburstRenderer");
  });

  it("dim triplet sits BEFORE the tree memo so the memo can consume it", () => {
    assertLiftedTripletBeforeTreeMemo(specialtySrc, "SunburstRenderer");
  });
});

describe("WD2-dim-echarts-treemap · SunburstRenderer dimLeaf helper + tree-memo wiring", () => {
  it("defines the dimLeaf helper inside the tree memo returning { opacity: 0.4 } for non-matching leaves", () => {
    assertDimLeafHelper(specialtySrc, "SunburstNode", "SunburstRenderer");
  });

  it("dimLeaf is called in BOTH the flat (!groupCh) and hierarchical branches", () => {
    // Use an indexOf-based check scoped to the Sunburst body so the
    // count isn't polluted by the SankeyRenderer body that lives in
    // the same file but has no `dimLeaf` (and shouldn't).
    const sunburstStart = specialtySrc.indexOf("export function SunburstRenderer");
    const sankeyStart = specialtySrc.indexOf("export function SankeyRenderer");
    assert.ok(sunburstStart >= 0 && sankeyStart > sunburstStart);
    const sunburstBody = specialtySrc.slice(sunburstStart, sankeyStart);
    const matches = sunburstBody.match(
      /const itemStyle = dimLeaf\(name\);\s*return itemStyle \? \{ name, value, itemStyle \} : \{ name, value \};/g,
    );
    assert.ok(
      matches && matches.length === 2,
      `SunburstRenderer's tree memo must call dimLeaf+spread in both flat AND hierarchical branches (got ${matches?.length ?? 0})`,
    );
  });

  it("tree memo dep array includes dashboardDimActive + dashboardFilters (Sunburst's body)", () => {
    // Anchor to the SunburstRenderer body so a later renderer in the
    // same file with a different memo signature doesn't false-match.
    const sunburstStart = specialtySrc.indexOf("export function SunburstRenderer");
    const sankeyStart = specialtySrc.indexOf("export function SankeyRenderer");
    const sunburstBody = specialtySrc.slice(sunburstStart, sankeyStart);
    assert.match(
      sunburstBody,
      /\}, \[data, labelCh, valueCh, groupCh, dashboardDimActive, dashboardFilters\]\);/,
    );
  });
});

// ── cross-cutting: opacity-only contract + leaf-only carve-out ─────

describe("WD2-dim-echarts-treemap · contracts shared with the rest of the WD2-dim-* family", () => {
  it("uses 0.4 as the dim factor (consistent with bar / cat / rect / trend / point)", () => {
    // Pin the opacity literal so a future visual-design wave can
    // change all WD2-dim-* renderers' factor in one sweep.
    assert.match(treemapSrc, /\{ opacity: 0\.4 \}/);
    assert.match(specialtySrc, /\{ opacity: 0\.4 \}/);
  });

  it("matching leaves emit a byte-identical pre-wave shape (no itemStyle field)", () => {
    // The conditional spread pattern keeps `optionsKey` stable when
    // no filter is active: matching leaves emit `{ name, value }`
    // identical to the pre-wave shape, so dim-off renders pass
    // through the same JSON.stringify byte stream the WD2-wiring-
    // echarts wave already pinned.
    assert.match(treemapSrc, /itemStyle \? \{ name, value, itemStyle \} : \{ name, value \}/);
    assert.match(specialtySrc, /itemStyle \? \{ name, value, itemStyle \} : \{ name, value \}/);
  });

  it("documentation comment names the leaf-only carve-out (mirrors WD2-wiring-echarts dispatch)", () => {
    // Documentation comment is load-bearing for future Claude:
    // names why parents don't dim (structural hierarchy, same
    // carve-out as the dispatch path).
    const treemapDimIdx = treemapSrc.indexOf("WD2-dim-echarts-treemap");
    const sunburstDimIdx = specialtySrc.indexOf("WD2-dim-echarts-treemap");
    assert.ok(treemapDimIdx >= 0, "TreemapRenderer must carry WD2-dim-echarts-treemap marker");
    assert.ok(sunburstDimIdx >= 0, "SunburstRenderer must carry WD2-dim-echarts-treemap marker");
  });
});
