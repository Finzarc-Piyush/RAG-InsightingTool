/**
 * Wave WD3-wiring-rest-cat · source-inspection tests for the 5
 * categorical visx renderers (Arc / Funnel / Box / Waterfall / Combo).
 * Each fans out the WD3-wiring-bar pattern at its own primary x-field
 * with its own raw-value identifier:
 *   - ArcRenderer       → labelCh.field × arc.data.rawKey
 *   - FunnelRenderer    → enc.x.field   × s.rawLabel
 *   - BoxRenderer       → enc.x.field   × s.rawCategory
 *   - WaterfallRenderer → enc.x.field   × b.rawCategory   (clickable gate ⇒ b.isTotal excluded)
 *   - ComboRenderer     → xCh.field     × rawX            (bars only; secondary-line untouched)
 *
 * Tests pin per renderer: the new drillThrough import; the event
 * parameter typing on the onClick arrow; the `if (isModifierClick(event))
 * { dispatchDrillThrough({...}); return; }` branch order BEFORE the
 * existing dispatchCrossFilter; the 5-field payload shape; the raw
 * (NOT toFilterValue-coerced) value; the WD3-wiring-rest-cat marker.
 * Cross-cutting: each renderer's drill column matches its dim + cross-
 * filter dispatch column (symmetry).
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

const renderers: Array<{
  name: string;
  src: string;
  column: string;
  rawValue: string;
  tileIdExpr: string;
  outerGate: string;
}> = [
  {
    name: "ArcRenderer",
    src: arcSrc,
    column: "labelCh.field",
    rawValue: "arc.data.rawKey",
    tileIdExpr: "dashboardTile.tileId",
    outerGate: "dashboardTile",
  },
  {
    name: "FunnelRenderer",
    src: funnelSrc,
    column: "enc.x.field",
    rawValue: "s.rawLabel",
    tileIdExpr: "dashboardTile.tileId",
    outerGate: "dashboardTile",
  },
  {
    name: "BoxRenderer",
    src: boxSrc,
    column: "enc.x.field",
    rawValue: "s.rawCategory",
    tileIdExpr: "dashboardTile.tileId",
    outerGate: "dashboardTile",
  },
  {
    name: "WaterfallRenderer",
    src: waterfallSrc,
    column: "enc.x.field",
    rawValue: "b.rawCategory",
    // WaterfallRenderer's onClick gate is `clickable` (which AND-skips
    // `b.isTotal`), but the dispatch reads `dashboardTile!.tileId`
    // because `clickable` already AND-includes `!!dashboardTile`.
    tileIdExpr: "dashboardTile!.tileId",
    outerGate: "clickable",
  },
  {
    name: "ComboRenderer",
    src: comboSrc,
    column: "xCh.field",
    rawValue: "rawX",
    tileIdExpr: "dashboardTile.tileId",
    outerGate: "dashboardTile",
  },
];

// Escape regex special characters so we can interpolate identifiers
// like `enc.x.field` into source-matching regexes without surprises.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const r of renderers) {
  describe(`WD3-wiring-rest-cat · ${r.name} imports the drillThrough helpers`, () => {
    it("named-imports isModifierClick + dispatchDrillThrough from @/pages/Dashboard/lib/drillThrough", () => {
      assert.match(
        r.src,
        /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
      );
    });

    it("keeps the WD2 crossFilter imports untouched (additive change)", () => {
      assert.match(
        r.src,
        /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
      );
    });
  });

  describe(`WD3-wiring-rest-cat · ${r.name} onClick gains the modifier-key drill-through branch`, () => {
    it("accepts the event parameter (typed React.MouseEvent<SVGElement>) on the onClick arrow", () => {
      const pat = new RegExp(
        `onClick=\\{\\s*${escape(r.outerGate)}\\s*\\?\\s*\\(event: React\\.MouseEvent<SVGElement>\\) =>`,
      );
      assert.match(r.src, pat);
    });

    it("modifier branch fires FIRST (before dispatchCrossFilter)", () => {
      const pat = new RegExp(
        `\\(event: React\\.MouseEvent<SVGElement>\\) => \\{[\\s\\S]*?if \\(isModifierClick\\(event\\)\\) \\{[\\s\\S]*?dispatchDrillThrough\\([\\s\\S]*?\\}[\\s\\S]*?dispatchCrossFilter\\(`,
      );
      assert.match(r.src, pat);
    });

    it("dispatchDrillThrough payload carries chartId / column / value (raw) / sourceTileId / filters", () => {
      const pat = new RegExp(
        `dispatchDrillThrough\\(\\{\\s*` +
          `chartId: ${escape(r.tileIdExpr)},\\s*` +
          `column: ${escape(r.column)},\\s*` +
          `value: ${escape(r.rawValue)},\\s*` +
          `sourceTileId: ${escape(r.tileIdExpr)},\\s*` +
          `filters: dashboardFilters,?\\s*\\}\\);`,
      );
      assert.match(r.src, pat);
    });

    it("modifier branch returns after dispatch (so cross-filter doesn't also fire)", () => {
      assert.match(
        r.src,
        /dispatchDrillThrough\(\{[\s\S]*?\}\);\s*return;/,
      );
    });

    it("drill value passed RAW (NOT toFilterValue-coerced) — server-side canonicalisation does the type-aware comparison", () => {
      const drillBlock = r.src.match(
        /dispatchDrillThrough\(\{[\s\S]*?\}\);/,
      )?.[0];
      assert.ok(drillBlock, `${r.name} must contain a dispatchDrillThrough block`);
      assert.doesNotMatch(drillBlock, /value: toFilterValue\(/);
    });

    it("plain-click (no modifier) still dispatches cross-filter (WD2-wiring-rest-cat contract preserved)", () => {
      // The pre-existing dispatchCrossFilter call stays after the
      // modifier branch — regression-pin against a refactor that
      // accidentally drops it.
      const pat = new RegExp(
        `dispatchCrossFilter\\(\\{\\s*` +
          `column: ${escape(r.column)},\\s*` +
          `value: toFilterValue\\(${escape(r.rawValue)}\\),\\s*` +
          `sourceTileId: ${escape(r.tileIdExpr)},?\\s*\\}\\);`,
      );
      assert.match(r.src, pat);
    });
  });
}

describe("WD3-wiring-rest-cat · cross-cutting contracts", () => {
  it("each renderer carries the WD3-wiring-rest-cat marker for grep-ability", () => {
    for (const r of renderers) {
      assert.match(r.src, /WD3-wiring-rest-cat/, `${r.name} must carry the marker`);
    }
  });

  it("dim + cross-filter + drill all share the same dispatch column per renderer (column-symmetry pin)", () => {
    // Drift here (e.g. Arc drilling on `valueCh.field` while dimming
    // on `labelCh.field`) would produce a "click-to-drill on a column
    // you can't click-to-filter" UX mismatch. Pin every dim /
    // dispatch / drill column triple.
    for (const r of renderers) {
      const drill = new RegExp(
        `dispatchDrillThrough\\(\\{[\\s\\S]*?column: ${escape(r.column)},`,
      );
      assert.match(r.src, drill, `${r.name} drill must use ${r.column}`);

      const xfilter = new RegExp(
        `dispatchCrossFilter\\(\\{\\s*column: ${escape(r.column)},`,
      );
      assert.match(r.src, xfilter, `${r.name} cross-filter must use ${r.column}`);

      const dim = new RegExp(
        `isCrossFilterActive\\(\\s*dashboardFilters!,\\s*${escape(r.column)},`,
      );
      assert.match(r.src, dim, `${r.name} dim must call isCrossFilterActive on ${r.column}`);
    }
  });

  it("WaterfallRenderer's drill is gated by `clickable` (running-total bars excluded)", () => {
    // The clickable gate already AND-skips `b.isTotal` upstream, so
    // a drill on a synthetic summary row can't fire. Pin the outer
    // gate so a refactor that switches to `dashboardTile` would
    // break loudly (it would let totals fire drill-through).
    assert.match(
      waterfallSrc,
      /onClick=\{\s*clickable\s*\?\s*\(event: React\.MouseEvent<SVGElement>\) =>/,
    );
  });

  it("ComboRenderer's drill stays on bars (secondary-axis line marks not wired)", () => {
    // The secondary-axis <LinePath> is continuous — a categorical
    // drill would have no per-mark target. Pin that the only
    // dispatchDrillThrough call inside ComboRenderer fires inside
    // the bar block (gated on `dashboardTile`), not anywhere near
    // a LinePath element. The dispatchDrillThrough call count
    // should be exactly 1 in ComboRenderer.
    const drillCount = (comboSrc.match(/dispatchDrillThrough\(/g) ?? []).length;
    assert.equal(
      drillCount,
      1,
      `ComboRenderer must dispatch drill-through exactly once (the bar onClick); found ${drillCount}`,
    );
  });
});
