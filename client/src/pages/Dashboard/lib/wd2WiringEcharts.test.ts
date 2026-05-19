/**
 * Wave WD2-wiring-echarts · source-inspection tests for the ECharts
 * specialty pack cross-filter wiring (Treemap, Sunburst, Sankey,
 * Calendar, Candlestick). The visx renderers (WD2-wiring-rest-cat /
 * rest-rect / rest-trend / rest-point) attach `onClick` directly to
 * SVG marks; ECharts mounts its own canvas instance via `EChartsBase`
 * and exposes events through `instance.on('click', handler)`. This
 * wave threads `onChartClick` through `EChartsBase` as an optional
 * prop and each renderer that owns a meaningful categorical click
 * target builds a per-renderer translator (`params` shape varies by
 * series type) that lands on the same `dispatchCrossFilter` boundary
 * the visx renderers already use.
 *
 * Parallel / Choropleth / Gauge are deliberately skipped — Parallel
 * lines are continuous (no meaningful categorical target), Choropleth
 * is a stub awaiting geo registration, and Gauge is a single-value KPI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const baseSrc = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/EChartsBase.tsx"),
  "utf-8",
);
const treemapSrc = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/TreemapRenderer.tsx"),
  "utf-8",
);
const specialtySrc = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/SpecialtyRenderers.tsx"),
  "utf-8",
);

describe("WD2-wiring-echarts · EChartsBase onChartClick prop", () => {
  it("declares the optional onChartClick prop on EChartsBaseProps", () => {
    assert.match(baseSrc, /onChartClick\?: \(params: unknown\) => void;/);
  });

  it("ref-tracks the latest callback so a single mount-time bind picks up renders", () => {
    // The mount effect runs once with empty deps. Without the ref, a
    // closure over the initial `onChartClick` would never see updates.
    assert.match(
      baseSrc,
      /const onChartClickRef = useRef<EChartsBaseProps\["onChartClick"\]>\(onChartClick\);/,
    );
    assert.match(
      baseSrc,
      /useEffect\(\(\) => \{\s*onChartClickRef\.current = onChartClick;\s*\},\s*\[onChartClick\]\);/,
    );
  });

  it("binds `inst.on('click', ...)` once inside the init() async block, after setOption", () => {
    // ECharts requires the instance to be initialised + options applied
    // before event binding takes effect. Placing the bind AFTER
    // `inst.setOption(...)` keeps the contract honest.
    const setOptionIdx = baseSrc.indexOf("inst.setOption(buildOptions(echarts, theme)");
    const onClickIdx = baseSrc.indexOf('inst.on("click"');
    assert.ok(setOptionIdx >= 0, "setOption call must exist");
    assert.ok(onClickIdx >= 0, "inst.on('click', ...) bind must exist");
    assert.ok(
      setOptionIdx < onClickIdx,
      "click bind must come after setOption (event binding requires initialised instance)",
    );
  });

  it("delegates the bound handler to the ref-tracked callback (latest identity)", () => {
    assert.match(
      baseSrc,
      /inst\.on\("click", \(params: unknown\) => \{\s*onChartClickRef\.current\?\.\(params\);\s*\}\);/,
    );
  });
});

describe("WD2-wiring-echarts · TreemapRenderer leaf-click dispatch", () => {
  it("imports useDashboardTileContext + dispatchCrossFilter + toFilterValue", () => {
    assert.match(
      treemapSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
    assert.match(
      treemapSrc,
      /import \{ dispatchCrossFilter, toFilterValue \} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("reads the dashboard-tile context once in the renderer body", () => {
    assert.match(treemapSrc, /const dashboardTile = useDashboardTileContext\(\);/);
  });

  it("builds onChartClick via useCallback with a leaf-only guard", () => {
    // Treemap parents have `children`; clicking a parent should not
    // dispatch — the dispatch column is `labelCh.field`, which is the
    // leaf's category, not the parent group.
    assert.match(
      treemapSrc,
      /const isLeaf = !Array\.isArray\(p\?\.data\?\.children\) \|\| p\.data\.children\.length === 0;/,
    );
    assert.match(treemapSrc, /if \(!isLeaf \|\| name == null\) return;/);
  });

  it("dispatches with { column: labelCh.field, value: toFilterValue(name), sourceTileId }", () => {
    assert.match(
      treemapSrc,
      /dispatchCrossFilter\(\{\s*column: labelCh\.field,\s*value: toFilterValue\(name\),\s*sourceTileId: dashboardTile\.tileId,\s*\}\);/,
    );
  });

  it("passes onChartClick to EChartsBase only when dashboardTile is set", () => {
    assert.match(
      treemapSrc,
      /onChartClick=\{dashboardTile \? onChartClick : undefined\}/,
    );
  });
});

describe("WD2-wiring-echarts · SunburstRenderer leaf-click dispatch", () => {
  it("imports the cross-filter helpers + dashboard-tile context", () => {
    assert.match(
      specialtySrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
    assert.match(
      specialtySrc,
      /import \{ dispatchCrossFilter, toFilterValue \} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("dispatches on leaf clicks via labelCh.field with the same leaf-guard pattern as Treemap", () => {
    assert.match(
      specialtySrc,
      /const onSunburstClick = useCallback\(\s*\(params: unknown\) => \{[\s\S]*?const isLeaf = !Array\.isArray\(p\?\.data\?\.children\) \|\| p\.data\.children\.length === 0;[\s\S]*?dispatchCrossFilter\(\{\s*column: labelCh\.field,\s*value: toFilterValue\(name\),\s*sourceTileId: dashboardTile\.tileId,\s*\}\);[\s\S]*?\},\s*\[dashboardTile, labelCh\.field\],\s*\);/,
    );
  });

  it("passes onSunburstClick to EChartsBase conditionally on dashboardTile", () => {
    assert.match(
      specialtySrc,
      /onChartClick=\{dashboardTile \? onSunburstClick : undefined\}/,
    );
  });
});

describe("WD2-wiring-echarts · SankeyRenderer node-click dispatch", () => {
  it("dispatches only on `params.dataType === 'node'`, skipping edges", () => {
    // Edges have no single categorical value — the source and target
    // are distinct entities and the dispatch column would be ambiguous.
    assert.match(
      specialtySrc,
      /if \(p\?\.dataType !== "node" \|\| p\?\.name == null\) return;/,
    );
  });

  it("dispatches with { column: sourceCh.field, value: toFilterValue(p.name), sourceTileId }", () => {
    // Source / target fields are typically two columns of the same
    // dimension (e.g. Region → Region), so dispatching on the source
    // covers both endpoints in practice. Cross-column sankeys would
    // need a richer decode; documented as out-of-scope in the body.
    assert.match(
      specialtySrc,
      /dispatchCrossFilter\(\{\s*column: sourceCh\.field,\s*value: toFilterValue\(p\.name\),\s*sourceTileId: dashboardTile\.tileId,\s*\}\);/,
    );
  });

  it("passes onSankeyClick to EChartsBase conditionally on dashboardTile", () => {
    assert.match(
      specialtySrc,
      /onChartClick=\{dashboardTile \? onSankeyClick : undefined\}/,
    );
  });
});

describe("WD2-wiring-echarts · CalendarRenderer cell-click dispatch", () => {
  it("dispatches on `dateCh.field` using params.data[0] (the yyyy-mm-dd string)", () => {
    // ECharts calendar params shape is `{ data: [iso, value] }`; the
    // first element is the date string the renderer formatted in the
    // series builder.
    assert.match(
      specialtySrc,
      /const date = Array\.isArray\(p\?\.data\) \? p\.data\[0\] : undefined;/,
    );
    assert.match(
      specialtySrc,
      /dispatchCrossFilter\(\{\s*column: dateCh\.field,\s*value: toFilterValue\(date\),\s*sourceTileId: dashboardTile\.tileId,\s*\}\);/,
    );
  });

  it("passes onCalendarClick to EChartsBase conditionally on dashboardTile", () => {
    assert.match(
      specialtySrc,
      /onChartClick=\{dashboardTile \? onCalendarClick : undefined\}/,
    );
  });
});

describe("WD2-wiring-echarts · CandlestickRenderer bar-click dispatch", () => {
  it("looks up the x-axis label via xs[dataIndex] (not params.value, which is the OHLC tuple)", () => {
    // The categorical key for a candlestick bar is the time label on
    // the x-axis, not the open/close/low/high tuple. The `xs` array
    // was already built for the x-axis category data.
    assert.match(
      specialtySrc,
      /if \(typeof idx !== "number" \|\| idx < 0 \|\| idx >= xs\.length\) return;\s*const label = xs\[idx\];/,
    );
  });

  it("dispatches with { column: xCh.field, value: toFilterValue(label), sourceTileId }", () => {
    assert.match(
      specialtySrc,
      /dispatchCrossFilter\(\{\s*column: xCh\.field,\s*value: toFilterValue\(label\),\s*sourceTileId: dashboardTile\.tileId,\s*\}\);/,
    );
  });

  it("passes onCandlestickClick to EChartsBase conditionally on dashboardTile", () => {
    assert.match(
      specialtySrc,
      /onChartClick=\{dashboardTile \? onCandlestickClick : undefined\}/,
    );
  });
});

describe("WD2-wiring-echarts · Parallel / Choropleth / Gauge stay unwired (no categorical click target)", () => {
  it("Parallel renderer does not import the cross-filter dispatch helpers", () => {
    // Continuous lines — no per-mark click target. Deliberately skipped.
    // Source-inspection: the Parallel renderer body does not reference
    // `dispatchCrossFilter` outside the shared module imports at the top.
    // (Imports at the top are shared across the file; we pin per-renderer
    // by checking the Parallel-specific function body doesn't contain a
    // `dispatchCrossFilter(` call site.)
    const parallelStart = specialtySrc.indexOf("export function ParallelRenderer");
    const parallelEnd = specialtySrc.indexOf("export function CalendarRenderer");
    assert.ok(parallelStart >= 0 && parallelEnd > parallelStart);
    const parallelBody = specialtySrc.slice(parallelStart, parallelEnd);
    assert.ok(
      !parallelBody.includes("dispatchCrossFilter("),
      "Parallel renderer must not dispatch cross-filter — continuous lines have no categorical click target",
    );
  });

  it("Choropleth renderer (stub) does not dispatch cross-filter", () => {
    const choroplethStart = specialtySrc.indexOf("export function ChoroplethRenderer");
    const choroplethEnd = specialtySrc.indexOf("export function GaugeRenderer");
    assert.ok(choroplethStart >= 0 && choroplethEnd > choroplethStart);
    const choroplethBody = specialtySrc.slice(choroplethStart, choroplethEnd);
    assert.ok(
      !choroplethBody.includes("dispatchCrossFilter("),
      "Choropleth stub must not dispatch cross-filter",
    );
  });

  it("Gauge renderer (single-value KPI) does not dispatch cross-filter", () => {
    const gaugeStart = specialtySrc.indexOf("export function GaugeRenderer");
    assert.ok(gaugeStart >= 0);
    const gaugeBody = specialtySrc.slice(gaugeStart);
    assert.ok(
      !gaugeBody.includes("dispatchCrossFilter("),
      "Gauge renderer must not dispatch cross-filter — single-value KPI has no categorical click target",
    );
  });
});
