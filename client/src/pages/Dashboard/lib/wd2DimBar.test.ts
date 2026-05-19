/**
 * Wave WD2-dim-bar · source-inspection tests for the BarRenderer
 * dim-non-matching-marks wiring. Pairs with the WD2-dim-foundation
 * context extension (filters on dashboardTileContext) and the
 * already-shipped `isCrossFilterActive` helper.
 *
 * The wiring is opacity-only: when the dashboard has an active
 * categorical cross-filter on `enc.x.field` AND a bar's `outerRaw`
 * isn't in the active selection, the bar's `fillOpacity` is
 * multiplied by 0.4. The pre-existing chat/explorer `grid.filter`
 * dim case (line 716–717 of BarRenderer.tsx) stays untouched —
 * `grid.inGrid` and `dashboardTile` are mutually exclusive contexts
 * (the existing WD2-wiring-bar foundation guarantees that), so the
 * two dim paths can't double-dim a single mark.
 *
 * Tests pin the new import, the lifted `dashboardDimActive` local
 * (computed once per render — categorical selection on x-field
 * exists AND has at least one value), the per-bar `isDashboardDimmed`
 * (active dim + bar's outerRaw NOT in selection), the opacity
 * expression branching, and the `isCrossFilterActive` signature
 * widening from narrow types to `unknown`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const barRendererSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BarRenderer.tsx"),
  "utf-8",
);
const crossFilterSrc = readFileSync(
  repoFile("./crossFilter.ts"),
  "utf-8",
);

describe("WD2-dim-bar · BarRenderer imports isCrossFilterActive alongside dispatchCrossFilter", () => {
  it("named-imports isCrossFilterActive from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      barRendererSrc,
      /import \{[\s\S]*?dispatchCrossFilter,[\s\S]*?isCrossFilterActive,[\s\S]*?toFilterValue,[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });
});

describe("WD2-dim-bar · dashboardDimActive lifted once per render", () => {
  it("reads filters off dashboardTile?.filters once at the top of the body", () => {
    // Pin the const name + access path so the dim factor source
    // doesn't accidentally read off a stale closure inside the map.
    assert.match(
      barRendererSrc,
      /const dashboardFilters = dashboardTile\?\.filters;/,
    );
  });

  it("selects the x-field filter selection via dashboardFilters?.[enc.x.field]", () => {
    assert.match(
      barRendererSrc,
      /const xFilterSel = dashboardFilters\?\.\[enc\.x\.field\];/,
    );
  });

  it("dashboardDimActive guards: selection exists AND is categorical AND has at least one value", () => {
    // All three guards are load-bearing: missing column entry → dim off,
    // numeric / date selection → dim off (cross-filter is discrete),
    // empty values array → dim off (so the user re-clearing the last
    // value reverts every bar to full opacity).
    assert.match(
      barRendererSrc,
      /const dashboardDimActive =\s*!!xFilterSel &&\s*xFilterSel\.type === "categorical" &&\s*xFilterSel\.values\.length > 0;/,
    );
  });

  it("the lifted locals live in the function body, NOT inside cells.map (so the categorical-selection lookup runs once per render not per bar)", () => {
    const liftIdx = barRendererSrc.indexOf("const dashboardDimActive =");
    const mapIdx = barRendererSrc.indexOf("{cells.map((c, i) => {");
    assert.ok(liftIdx >= 0 && mapIdx >= 0);
    assert.ok(
      liftIdx < mapIdx,
      "dashboardDimActive must be lifted ABOVE the cells.map JSX body",
    );
  });
});

describe("WD2-dim-bar · per-bar isDashboardDimmed via isCrossFilterActive", () => {
  it("isDashboardDimmed is gated by dashboardDimActive AND !isCrossFilterActive(filters, enc.x.field, c.outerRaw)", () => {
    assert.match(
      barRendererSrc,
      /const isDashboardDimmed =\s*dashboardDimActive &&\s*!isCrossFilterActive\(\s*dashboardFilters!,\s*enc\.x\.field,\s*c\.outerRaw,\s*\);/,
    );
  });

  it("passes c.outerRaw directly (NOT toFilterValue(c.outerRaw)) — isCrossFilterActive does the coercion internally", () => {
    // Pin against a future refactor that double-coerces.
    // isCrossFilterActive.body calls toFilterValue(value) once; passing
    // the already-coerced string would still work but creates redundant
    // surface area. Keep the call site clean.
    const callIdx = barRendererSrc.indexOf("isCrossFilterActive(");
    assert.ok(callIdx >= 0, "isCrossFilterActive must be called");
    const callArgs = barRendererSrc.slice(callIdx, callIdx + 200);
    assert.doesNotMatch(callArgs, /toFilterValue\(/);
  });
});

describe("WD2-dim-bar · fillOpacity branches", () => {
  it("dashboard-dim branch is added AFTER the grid.filter branch, BEFORE the default 1", () => {
    // The chat/explorer (`grid.inGrid && grid.filter`) branch must come
    // first because `grid.inGrid` and `dashboardTile` are mutually
    // exclusive — if both were ever true, the existing chat/explorer
    // path should win. The dashboardDim branch fires only when the
    // grid path doesn't.
    assert.match(
      barRendererSrc,
      /\(isFiltered\s*\?\s*1\s*:\s*grid\.inGrid && grid\.filter\s*\?\s*0\.4\s*:\s*isDashboardDimmed\s*\?\s*0\.4\s*:\s*1\)/,
    );
  });

  it("uses 0.4 as the dim factor (matches the existing chat/explorer dim factor)", () => {
    // Symmetric with the grid.filter branch — a future visual-design
    // wave can change both factors together if needed. Find the
    // USAGE site of isDashboardDimmed in the fillOpacity ternary
    // (NOT the first occurrence which is the assignment).
    const firstIdx = barRendererSrc.indexOf("isDashboardDimmed");
    assert.ok(firstIdx >= 0);
    const usageIdx = barRendererSrc.indexOf(
      "isDashboardDimmed",
      firstIdx + "isDashboardDimmed".length,
    );
    assert.ok(usageIdx >= 0, "isDashboardDimmed must be used after assignment");
    const after = barRendererSrc.slice(usageIdx, usageIdx + 200);
    assert.match(after, /\?\s*0\.4\s*:\s*1/);
  });

  it("does NOT add an outline (stroke / strokeWidth) for dashboard-matching bars — purely opacity-based", () => {
    // The existing isFiltered branch in chat/explorer adds a 1.5-px
    // stroke + outline; the dashboard dim case stays opacity-only
    // because the user's mental model on a multi-tile dashboard is
    // "the brushed tile shows the filter, every other tile dims" —
    // outlining matching bars on every tile would be visually noisy.
    assert.doesNotMatch(
      barRendererSrc,
      /isDashboardDimmed\s*\?\s*"hsl\(var\(--foreground\)\)"/,
    );
    assert.doesNotMatch(
      barRendererSrc,
      /strokeWidth=\{isDashboardDimmed/,
    );
  });
});

describe("WD2-dim-bar · isCrossFilterActive signature widened to unknown", () => {
  it("crossFilter.ts widens the value parameter to unknown (matches toFilterValue precedent)", () => {
    assert.match(
      crossFilterSrc,
      /export function isCrossFilterActive\(\s*global: ActiveChartFilters,\s*column: string,\s*value: unknown,\s*\): boolean \{/,
    );
  });

  it("function body still calls toFilterValue(value) for the membership check (existing behaviour preserved)", () => {
    assert.match(
      crossFilterSrc,
      /return sel\.values\.includes\(toFilterValue\(value\)\);/,
    );
  });

  it("doc-comment names the WD2-wiring-bar precedent for the widening", () => {
    // Comment is the audit trail for why this signature looks wider
    // than the symmetric `applyCrossFilter` / `removeCrossFilter` /
    // `clearCrossFilter` shapes. Pin so a future refactor doesn't
    // narrow it back.
    assert.match(crossFilterSrc, /WD2-wiring-bar/);
    assert.match(crossFilterSrc, /value\` accepts \`unknown\`/);
  });
});

describe("WD2-dim-bar · documentation comment names mutual exclusion with grid.filter", () => {
  it("the lifted locals comment names the chat/explorer `grid.filter` dim parallel", () => {
    // Documentation comment is load-bearing for future Claude: names
    // the mutual exclusion with the existing chat/explorer dim path
    // so a future renderer wave doesn't try to consolidate them.
    const idx = barRendererSrc.indexOf("WD2-dim-bar");
    assert.ok(idx >= 0, "WD2-dim-bar wave marker must be in source");
    const after = barRendererSrc.slice(idx, idx + 600);
    assert.match(after, /grid\.filter/);
  });
});
