/**
 * Wave WD3-wiring-echarts · source-inspection tests for the 5 ECharts
 * mark renderers (Treemap / Sunburst / Sankey / Calendar / Candlestick).
 *
 * The wave layers the WD3 modifier-key intent on top of the existing
 * WD2-wiring-echarts dispatch. ECharts wraps the native MouseEvent at
 * `params.event.event` (the ZRender event object wrapping the DOM
 * event). `isModifierClick(p.event.event)` reads `metaKey` / `ctrlKey`
 * with no foundation changes — the helper accepts the sparse event
 * shape from WD3-foundation.
 *
 * Per-renderer wiring follows the WD2 dispatch shape:
 *   - Treemap: `labelCh.field` × leaf name (parents un-wired —
 *     structural hierarchy)
 *   - Sunburst: same as Treemap
 *   - Sankey: `sourceCh.field` × node.name (edges un-wired)
 *   - Calendar: `dateCh.field` × the [date] tuple element (raw ISO
 *     string, NOT toFilterValue-coerced)
 *   - Candlestick: `xCh.field` × `xs[idx]` (the categorical x-axis
 *     label, NOT the OHLC tuple values)
 *
 * 4 of 5 renderers (all except Sunburst) need `dashboardFilters`
 * lifted ABOVE the click handler so the modifier branch can capture
 * it in its closure for the drill-through `filters` snapshot. Sunburst
 * already had the right ordering pre-wave.
 *
 * Tests pin: import shape (both source files); per-renderer modifier
 * branch fires BEFORE dispatchCrossFilter; per-renderer 5-field
 * payload (chartId / column / value RAW / sourceTileId / filters);
 * the WD2 cross-filter regression preserved; `dashboardFilters`
 * appears in the useCallback dependency arrays; cross-cutting marker;
 * each renderer's drill column matches its WD2 cross-filter column.
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

// ── Imports ─────────────────────────────────────────────────────────

describe("WD3-wiring-echarts · imports", () => {
  it("TreemapRenderer named-imports isModifierClick + dispatchDrillThrough", () => {
    assert.match(
      treemapSrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("SpecialtyRenderers named-imports isModifierClick + dispatchDrillThrough (shared across 4 renderers)", () => {
    // One import block serves Sunburst + Sankey + Calendar +
    // Candlestick — they all live in the same file.
    assert.match(
      specialtySrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("both files keep the WD2 crossFilter imports untouched (additive change)", () => {
    assert.match(
      treemapSrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
    assert.match(
      specialtySrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

// ── Per-renderer table-driven assertions ────────────────────────────

interface RendererCase {
  name: string;
  src: string;
  handlerName: string;
  column: string;
  valueExpr: string;
}

const CASES: RendererCase[] = [
  {
    name: "Treemap",
    src: treemapSrc,
    handlerName: "onChartClick",
    column: "labelCh.field",
    valueExpr: "name",
  },
  {
    name: "Sunburst",
    src: specialtySrc,
    handlerName: "onSunburstClick",
    column: "labelCh.field",
    valueExpr: "name",
  },
  {
    name: "Sankey",
    src: specialtySrc,
    handlerName: "onSankeyClick",
    column: "sourceCh.field",
    valueExpr: "p.name",
  },
  {
    name: "Calendar",
    src: specialtySrc,
    handlerName: "onCalendarClick",
    column: "dateCh.field",
    valueExpr: "date",
  },
  {
    name: "Candlestick",
    src: specialtySrc,
    handlerName: "onCandlestickClick",
    column: "xCh.field",
    valueExpr: "label",
  },
];

describe("WD3-wiring-echarts · per-renderer modifier branch fires BEFORE dispatchCrossFilter", () => {
  for (const c of CASES) {
    it(`${c.name}: handler body contains isModifierClick → dispatchDrillThrough → return; BEFORE dispatchCrossFilter`, () => {
      // The branch order is load-bearing — without the `return;` and
      // BEFORE-cross-filter placement, a cmd-click would fire BOTH
      // drill and cross-filter. Anchored on the per-renderer handler
      // name so a refactor that renames doesn't silently break the
      // assertion.
      const handlerRe = new RegExp(
        `const ${c.handlerName} = useCallback\\([\\s\\S]*?if \\(isModifierClick\\(p\\?\\.event\\?\\.event\\)\\) \\{[\\s\\S]*?dispatchDrillThrough\\(\\{[\\s\\S]*?\\}\\);[\\s\\S]*?return;[\\s\\S]*?\\}[\\s\\S]*?dispatchCrossFilter\\(`,
      );
      assert.match(c.src, handlerRe);
    });
  }
});

describe("WD3-wiring-echarts · per-renderer drill payload shape", () => {
  for (const c of CASES) {
    it(`${c.name}: dispatchDrillThrough payload carries chartId / column / value RAW / sourceTileId / filters`, () => {
      // Pin all 5 fields in the per-renderer drill block. Column +
      // value are renderer-specific (the case table). chartId /
      // sourceTileId are uniform = dashboardTile.tileId. filters =
      // dashboardFilters (must be lifted ABOVE the handler for 4 of
      // 5 renderers).
      const drillRe = new RegExp(
        `dispatchDrillThrough\\(\\{\\s*chartId: dashboardTile\\.tileId,\\s*column: ${c.column.replace(/\./g, "\\.")},\\s*value: ${c.valueExpr.replace(/[.?]/g, (m) => "\\" + m)},\\s*sourceTileId: dashboardTile\\.tileId,\\s*filters: dashboardFilters,?\\s*\\}\\);`,
      );
      assert.match(c.src, drillRe);
    });
  }
});

describe("WD3-wiring-echarts · per-renderer value passed RAW (no toFilterValue in drill block)", () => {
  for (const c of CASES) {
    it(`${c.name}: the drill block does NOT contain toFilterValue(`, () => {
      // Negative pin: server-side canonicaliser handles per-column
      // comparison. Coercing client-side would lose type information
      // (especially for Calendar's ISO date string and Candlestick's
      // potentially-temporal x labels).
      const handlerRe = new RegExp(
        `const ${c.handlerName} = useCallback\\([\\s\\S]*?dispatchDrillThrough\\(\\{[\\s\\S]*?\\}\\);[\\s\\S]*?return;`,
      );
      const handlerMatch = c.src.match(handlerRe);
      assert.ok(handlerMatch, `${c.name} handler must contain the drill block`);
      // Extract just the drill block within the matched handler.
      const drillBlockMatch = handlerMatch[0].match(
        /dispatchDrillThrough\(\{[\s\S]*?\}\);/,
      );
      assert.ok(drillBlockMatch, `${c.name} must contain a dispatchDrillThrough block`);
      assert.doesNotMatch(drillBlockMatch[0], /value: toFilterValue\(/);
    });
  }
});

describe("WD3-wiring-echarts · per-renderer typing: params.event.event chain narrows for isModifierClick", () => {
  for (const c of CASES) {
    it(`${c.name}: params cast widens to include event.event.metaKey/ctrlKey`, () => {
      // Pin the typed cast so a future refactor that drops the type
      // annotation doesn't silently disable the modifier check (which
      // would still typecheck but `p?.event?.event` would be unknown).
      const castRe = new RegExp(
        `const ${c.handlerName} = useCallback\\([\\s\\S]*?const p = params as \\{[\\s\\S]*?event\\?: \\{ event\\?: \\{ metaKey\\?: boolean; ctrlKey\\?: boolean \\} \\};[\\s\\S]*?\\};`,
      );
      assert.match(c.src, castRe);
    });
  }
});

describe("WD3-wiring-echarts · per-renderer useCallback deps include dashboardFilters", () => {
  for (const c of CASES) {
    it(`${c.name}: useCallback deps array contains dashboardFilters`, () => {
      // Without dashboardFilters in the deps, a stale closure would
      // dispatch a drill with a snapshot from initial mount even
      // after the user changes global filters. Pin per-renderer.
      const depsRe = new RegExp(
        `const ${c.handlerName} = useCallback\\([\\s\\S]*?\\},\\s*\\[[\\s\\S]*?dashboardFilters[\\s\\S]*?\\],?\\s*\\);`,
      );
      assert.match(c.src, depsRe);
    });
  }
});

// ── WD2 cross-filter regression ────────────────────────────────────

describe("WD3-wiring-echarts · WD2 cross-filter dispatch preserved per renderer", () => {
  it("Treemap plain-click still dispatches cross-filter on labelCh.field with toFilterValue(name)", () => {
    assert.match(
      treemapSrc,
      /dispatchCrossFilter\(\{\s*column: labelCh\.field,\s*value: toFilterValue\(name\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });

  it("Sunburst plain-click still dispatches cross-filter on labelCh.field with toFilterValue(name)", () => {
    // Find within the onSunburstClick handler specifically (not the
    // Treemap one — they share the same column name).
    assert.match(
      specialtySrc,
      /const onSunburstClick = useCallback\([\s\S]*?dispatchCrossFilter\(\{\s*column: labelCh\.field,\s*value: toFilterValue\(name\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });

  it("Sankey plain-click still dispatches cross-filter on sourceCh.field with toFilterValue(p.name)", () => {
    assert.match(
      specialtySrc,
      /const onSankeyClick = useCallback\([\s\S]*?dispatchCrossFilter\(\{\s*column: sourceCh\.field,\s*value: toFilterValue\(p\.name\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });

  it("Calendar plain-click still dispatches cross-filter on dateCh.field with toFilterValue(date)", () => {
    assert.match(
      specialtySrc,
      /const onCalendarClick = useCallback\([\s\S]*?dispatchCrossFilter\(\{\s*column: dateCh\.field,\s*value: toFilterValue\(date\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });

  it("Candlestick plain-click still dispatches cross-filter on xCh.field with toFilterValue(label)", () => {
    assert.match(
      specialtySrc,
      /const onCandlestickClick = useCallback\([\s\S]*?dispatchCrossFilter\(\{\s*column: xCh\.field,\s*value: toFilterValue\(label\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });
});

// ── dashboardFilters lift ordering (4 of 5 renderers) ──────────────

describe("WD3-wiring-echarts · dashboardFilters lifted ABOVE the click handler in 4 of 5 renderers", () => {
  it("Treemap: dashboardFilters declaration precedes the onChartClick declaration in source order", () => {
    const filterIdx = treemapSrc.indexOf("const dashboardFilters = dashboardTile?.filters;");
    const handlerIdx = treemapSrc.indexOf("const onChartClick = useCallback");
    assert.ok(filterIdx > 0, "Treemap must declare dashboardFilters");
    assert.ok(handlerIdx > 0, "Treemap must declare onChartClick");
    assert.ok(
      filterIdx < handlerIdx,
      "Treemap: dashboardFilters must be declared BEFORE onChartClick for closure capture",
    );
  });

  it("Sankey: dashboardFilters declaration precedes onSankeyClick", () => {
    // Sankey's filter declaration uses `sourceFilterSel` for the
    // dim concern, but the dashboardFilters lift is what the handler
    // needs. Anchor on the const declaration in the right file.
    const sankeyHandlerIdx = specialtySrc.indexOf(
      "const onSankeyClick = useCallback",
    );
    assert.ok(sankeyHandlerIdx > 0, "must find onSankeyClick");
    const preHandlerSlice = specialtySrc.slice(0, sankeyHandlerIdx);
    // Find the LAST dashboardFilters declaration before the handler.
    const lastFilterDecl = preHandlerSlice.lastIndexOf(
      "const dashboardFilters = dashboardTile?.filters;",
    );
    assert.ok(
      lastFilterDecl > 0,
      "Sankey: dashboardFilters must be declared BEFORE onSankeyClick",
    );
  });

  it("Calendar: dashboardFilters declaration precedes onCalendarClick", () => {
    const calHandlerIdx = specialtySrc.indexOf(
      "const onCalendarClick = useCallback",
    );
    assert.ok(calHandlerIdx > 0, "must find onCalendarClick");
    const preHandlerSlice = specialtySrc.slice(0, calHandlerIdx);
    const lastFilterDecl = preHandlerSlice.lastIndexOf(
      "const dashboardFilters = dashboardTile?.filters;",
    );
    assert.ok(
      lastFilterDecl > 0,
      "Calendar: dashboardFilters must be declared BEFORE onCalendarClick",
    );
  });

  it("Candlestick: dashboardFilters declaration precedes onCandlestickClick", () => {
    const candleHandlerIdx = specialtySrc.indexOf(
      "const onCandlestickClick = useCallback",
    );
    assert.ok(candleHandlerIdx > 0, "must find onCandlestickClick");
    const preHandlerSlice = specialtySrc.slice(0, candleHandlerIdx);
    const lastFilterDecl = preHandlerSlice.lastIndexOf(
      "const dashboardFilters = dashboardTile?.filters;",
    );
    assert.ok(
      lastFilterDecl > 0,
      "Candlestick: dashboardFilters must be declared BEFORE onCandlestickClick",
    );
  });
});

// ── Cross-cutting contracts ─────────────────────────────────────────

describe("WD3-wiring-echarts · cross-cutting contracts", () => {
  it("both source files carry the WD3-wiring-echarts marker", () => {
    assert.match(treemapSrc, /WD3-wiring-echarts/);
    assert.match(specialtySrc, /WD3-wiring-echarts/);
  });

  it("each renderer's drill column matches its WD2 cross-filter column (column-symmetry)", () => {
    // For each renderer, the drill `column:` literal equals the
    // WD2 cross-filter `column:` literal. Drift would produce a
    // "drill on a column you can't filter" UX mismatch.
    for (const c of CASES) {
      const drillColRe = new RegExp(
        `dispatchDrillThrough\\(\\{[\\s\\S]*?column: ${c.column.replace(/\./g, "\\.")},`,
      );
      const xfColRe = new RegExp(
        `dispatchCrossFilter\\(\\{\\s*column: ${c.column.replace(/\./g, "\\.")},`,
      );
      assert.match(c.src, drillColRe, `${c.name} drill column must be ${c.column}`);
      assert.match(c.src, xfColRe, `${c.name} cross-filter column must be ${c.column}`);
    }
  });

  it("total drill dispatch count across both files is exactly 5 (one per renderer)", () => {
    const treemapCount = (treemapSrc.match(/dispatchDrillThrough\(/g) ?? [])
      .length;
    const specialtyCount = (specialtySrc.match(/dispatchDrillThrough\(/g) ?? [])
      .length;
    assert.equal(treemapCount, 1, `Treemap expected 1 drill dispatch, found ${treemapCount}`);
    assert.equal(
      specialtyCount,
      4,
      `SpecialtyRenderers (Sunburst+Sankey+Calendar+Candlestick) expected 4 drill dispatches, found ${specialtyCount}`,
    );
  });

  it("Parallel + Choropleth + Gauge renderers do NOT add drill dispatches (no categorical click target)", () => {
    // Pin the same skip-list as the WD2 wiring family: Parallel
    // (continuous coordinates), Choropleth (geo-stub), Gauge (single
    // value) have no meaningful categorical click target. Negative
    // pin ensures a future maintainer doesn't accidentally wire them.
    const parallelStart = specialtySrc.indexOf("export function ParallelRenderer");
    const calendarStart = specialtySrc.indexOf("export function CalendarRenderer");
    assert.ok(parallelStart > 0 && calendarStart > parallelStart, "expected Parallel to precede Calendar");
    const parallelSlice = specialtySrc.slice(parallelStart, calendarStart);
    assert.doesNotMatch(parallelSlice, /dispatchDrillThrough\(/);
  });
});
