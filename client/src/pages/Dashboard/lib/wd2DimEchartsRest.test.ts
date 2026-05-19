/**
 * Wave WD2-dim-echarts-rest · source-inspection tests for the three
 * remaining ECharts specialty renderers: SankeyRenderer +
 * CalendarRenderer + CandlestickRenderer. Closes the WD2-dim-echarts
 * series.
 *
 * Each renderer adds a `dimmedX` memo (separate from the pre-wave
 * data memo) that emits a dim-aware data array consumed by ECharts.
 * The pre-wave data memos stay byte-identical for any downstream
 * consumer (range / visualMap min/max for Calendar; identity for
 * Sankey + Candlestick). When dim is OFF, `dimmedX` is identity
 * (=== pre-wave data) so the JSON serialised into `optionsKey`
 * stays byte-identical to the pre-wave shape — prevents an
 * unnecessary canvas re-render on initial mount.
 *
 * Per-renderer per-dataItem shape:
 *   - **Sankey**: `nodes` array of `{ name }` objects → promoted to
 *     `[{ name, itemStyle: { opacity: 0.4 } }]` for non-matching
 *     nodes via spread (`{ ...n, itemStyle: { opacity: 0.4 } }`).
 *     Edges (links) stay un-dimmed — same carve-out as the WD2-
 *     wiring-echarts dispatch (an edge has no single categorical
 *     value to filter on).
 *   - **Calendar**: `series` array of `[date, value]` tuples → mixed
 *     array of tuples (matching cells) and `{ value, itemStyle }`
 *     objects (non-matching cells). ECharts heatmap accepts both
 *     forms.
 *   - **Candlestick**: `series` array of `[o, c, low, high]` OHLC
 *     tuples → mixed array of tuples and `{ value: tuple, itemStyle }`
 *     objects. The dim membership is checked against `xs[i]`, not
 *     the OHLC values (which are quantitative).
 *
 * The `optionsKey` JSON field name stays as `nodes` / `series` (the
 * pre-wave name) so the dim-off JSON is byte-identical to pre-wave.
 *
 * Tests pin: each renderer's lifted dim triplet on the correct
 * dispatch column, the `dimmedX` memo's identity short-circuit, the
 * per-renderer non-matching-shape construction, the `optionsKey`
 * field-name preservation, and the data binding to `dimmedX` inside
 * `buildOptions`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const src = readFileSync(
  repoFile("../../../lib/charts/echartsRenderers/SpecialtyRenderers.tsx"),
  "utf-8",
);

// Slice the file into per-renderer bodies so assertions don't
// false-match across renderers. Each renderer starts at
// `export function <Name>Renderer` and ends at the next renderer's
// declaration.
const sliceRenderer = (start: string, end: string): string => {
  const startIdx = src.indexOf(start);
  const endIdx = src.indexOf(end);
  assert.ok(startIdx >= 0, `must find ${start}`);
  assert.ok(endIdx > startIdx, `must find ${end} after ${start}`);
  return src.slice(startIdx, endIdx);
};

const sankeyBody = sliceRenderer(
  "export function SankeyRenderer",
  "export function ParallelRenderer",
);
const calendarBody = sliceRenderer(
  "export function CalendarRenderer",
  "export function CandlestickRenderer",
);
const candlestickBody = sliceRenderer(
  "export function CandlestickRenderer",
  "export function ChoroplethRenderer",
);

// ── SankeyRenderer ─────────────────────────────────────────────────

describe("WD2-dim-echarts-rest · SankeyRenderer per-node dim on sourceCh.field", () => {
  it("lifts the dim triplet on sourceCh.field with full categorical guards", () => {
    assert.match(sankeyBody, /const dashboardFilters = dashboardTile\?\.filters;/);
    assert.match(sankeyBody, /const sourceFilterSel = dashboardFilters\?\.\[sourceCh\.field\];/);
    assert.match(
      sankeyBody,
      /const dashboardDimActive =\s*!!sourceFilterSel &&\s*sourceFilterSel\.type === "categorical" &&\s*sourceFilterSel\.values\.length > 0;/,
    );
  });

  it("dimmedNodes memo short-circuits to identity when dim is OFF", () => {
    // The `if (!dashboardDimActive) return nodes;` short-circuit
    // preserves byte-identical pre-wave JSON when no filter is
    // active — dim-off transitions never churn the optionsKey.
    assert.match(
      sankeyBody,
      /const dimmedNodes = useMemo<[\s\S]*?>\(\(\) => \{\s*if \(!dashboardDimActive\) return nodes;/,
    );
  });

  it("dimmedNodes promotes non-matching nodes via spread + itemStyle: { opacity: 0.4 }", () => {
    assert.match(
      sankeyBody,
      /return nodes\.map\(\(n\) =>\s*isCrossFilterActive\(dashboardFilters!, sourceCh\.field, n\.name\)\s*\?\s*n\s*:\s*\{ \.\.\.n, itemStyle: \{ opacity: 0\.4 \} \},?\s*\);/,
    );
  });

  it("optionsKey field name stays as `nodes` (byte-identical pre-wave JSON on dim-off)", () => {
    // The JSON serialisation uses `{ nodes: dimmedNodes, ... }` so
    // when dimmedNodes === nodes (dim-off), the produced JSON is
    // identical to the pre-wave `{ nodes, ... }` shape.
    assert.match(
      sankeyBody,
      /JSON\.stringify\(\{ nodes: dimmedNodes, links, w: width, h: height \}\)/,
    );
  });

  it("series data binding inside buildOptions uses dimmedNodes (not the pre-wave nodes)", () => {
    // Pin the buildOptions wiring so a future refactor doesn't
    // accidentally revert the data source. The dispatch path stays
    // on the pre-wave nodes/links shape — only the rendering data
    // sees the dim-aware version.
    assert.match(
      sankeyBody,
      /type: "sankey",\s*data: dimmedNodes,\s*links,/,
    );
  });

  it("edges (links) stay un-dimmed — only nodes carry per-item opacity", () => {
    // The dim memo touches only `nodes`; `links` flows through
    // unchanged. Pin against a future refactor that wraps links
    // too — edges have no categorical key to filter on.
    assert.doesNotMatch(sankeyBody, /links\.map\([\s\S]{0,200}itemStyle/);
  });
});

// ── CalendarRenderer ───────────────────────────────────────────────

describe("WD2-dim-echarts-rest · CalendarRenderer per-cell dim on dateCh.field", () => {
  it("lifts the dim triplet on dateCh.field with full categorical guards", () => {
    assert.match(calendarBody, /const dashboardFilters = dashboardTile\?\.filters;/);
    assert.match(calendarBody, /const dateFilterSel = dashboardFilters\?\.\[dateCh\.field\];/);
    assert.match(
      calendarBody,
      /const dashboardDimActive =\s*!!dateFilterSel &&\s*dateFilterSel\.type === "categorical" &&\s*dateFilterSel\.values\.length > 0;/,
    );
  });

  it("dimmedSeries memo short-circuits to identity when dim is OFF", () => {
    assert.match(
      calendarBody,
      /const dimmedSeries = useMemo<[\s\S]*?>\(\(\) => \{\s*if \(!dashboardDimActive\) return series;/,
    );
  });

  it("dimmedSeries promotes non-matching cells from [date, value] tuple to { value: [date, value], itemStyle: { opacity: 0.4 } } object", () => {
    assert.match(
      calendarBody,
      /return series\.map\(\(\[date, value\]\) =>\s*isCrossFilterActive\(dashboardFilters!, dateCh\.field, date\)\s*\?\s*\(\[date, value\] as \[string, number\]\)\s*:\s*\{ value: \[date, value\] as \[string, number\], itemStyle: \{ opacity: 0\.4 \} \},?\s*\);/,
    );
  });

  it("matching cells emit the tuple shape (byte-identical pre-wave)", () => {
    // Matching cells stay as `[date, value]` tuples so the JSON
    // serialisation is identical to the pre-wave shape — only
    // non-matching cells get the rich-object form.
    assert.match(calendarBody, /\?\s*\(\[date, value\] as \[string, number\]\)/);
  });

  it("optionsKey field name stays as `series` (byte-identical pre-wave JSON on dim-off)", () => {
    assert.match(
      calendarBody,
      /JSON\.stringify\(\{ series: dimmedSeries, range, w: width, h: height \}\)/,
    );
  });

  it("range memo + visualMap min/max consume the pre-wave `series` (not dimmedSeries)", () => {
    // The range computation uses tuple destructuring `series.map
    // (([s]) => ...)` which would break on the rich-object form.
    // Pin that the range memo reads `series` (pre-wave) not
    // `dimmedSeries`.
    assert.match(
      calendarBody,
      /const ys = series\.map\(\(\[s\]\) => Number\(s\.slice\(0, 4\)\)\);/,
    );
    // visualMap min/max bounds also read tuple form via
    // `series.map(([, v]) => v)`.
    assert.match(calendarBody, /Math\.min\(\.\.\.series\.map\(\(\[, v\]\) => v\), 0\)/);
    assert.match(calendarBody, /Math\.max\(\.\.\.series\.map\(\(\[, v\]\) => v\), 1\)/);
  });

  it("series data binding inside buildOptions uses dimmedSeries (not the pre-wave series)", () => {
    assert.match(
      calendarBody,
      /type: "heatmap",\s*coordinateSystem: "calendar",\s*data: dimmedSeries,/,
    );
  });
});

// ── CandlestickRenderer ────────────────────────────────────────────

describe("WD2-dim-echarts-rest · CandlestickRenderer per-bar dim on xCh.field", () => {
  it("lifts the dim triplet on xCh.field with full categorical guards", () => {
    assert.match(candlestickBody, /const dashboardFilters = dashboardTile\?\.filters;/);
    assert.match(candlestickBody, /const xFilterSel = dashboardFilters\?\.\[xCh\.field\];/);
    assert.match(
      candlestickBody,
      /const dashboardDimActive =\s*!!xFilterSel &&\s*xFilterSel\.type === "categorical" &&\s*xFilterSel\.values\.length > 0;/,
    );
  });

  it("dimmedSeries memo short-circuits to identity when dim is OFF", () => {
    assert.match(
      candlestickBody,
      /const dimmedSeries = useMemo<[\s\S]*?>\(\(\) => \{\s*if \(!dashboardDimActive\) return series;/,
    );
  });

  it("dim membership checks xs[i] (the categorical x-axis label), NOT the OHLC tuple values", () => {
    // OHLC values are quantitative (open / close / low / high
    // numbers); the categorical key for the dim factor is the
    // row's x-axis label in `xs[i]` (typically an ISO date).
    // Confusing the two would dim by quantitative-value match —
    // structurally meaningless on a categorical x-axis.
    assert.match(
      candlestickBody,
      /return series\.map\(\(tuple, i\) => \{\s*const x = xs\[i\];\s*if \(x == null\) return tuple;\s*return isCrossFilterActive\(dashboardFilters!, xCh\.field, x\)/,
    );
  });

  it("dimmedSeries promotes non-matching tuples to { value: tuple, itemStyle: { opacity: 0.4 } }", () => {
    assert.match(
      candlestickBody,
      /\?\s*tuple\s*:\s*\{ value: tuple, itemStyle: \{ opacity: 0\.4 \} \};/,
    );
  });

  it("dimmedSeries memo deps include xs (so xs reshuffling triggers dim-recompute)", () => {
    // The dim memo's key relationship is to `xs[i]`, so a change
    // in `xs` (e.g. if the underlying data reorders) must trigger
    // a rebuild. Pin that the deps include both `series` AND `xs`.
    assert.match(
      candlestickBody,
      /\}, \[series, xs, dashboardDimActive, dashboardFilters, xCh\.field\]\);/,
    );
  });

  it("optionsKey field name stays as `series` (byte-identical pre-wave JSON on dim-off)", () => {
    assert.match(
      candlestickBody,
      /JSON\.stringify\(\{ xs, series: dimmedSeries, w: width, h: height \}\)/,
    );
  });

  it("series data binding inside buildOptions uses dimmedSeries", () => {
    assert.match(
      candlestickBody,
      /type: "candlestick",\s*data: dimmedSeries,/,
    );
  });
});

// ── cross-cutting contracts ────────────────────────────────────────

describe("WD2-dim-echarts-rest · shared contracts with the WD2-dim-* family", () => {
  it("uses 0.4 as the dim factor (consistent with bar / cat / rect / trend / point / treemap)", () => {
    // Pin the opacity literal across all three renderers in this
    // wave. A future visual-design wave can change the factor in
    // one sweep across the WD2-dim-* family.
    assert.match(sankeyBody, /opacity: 0\.4/);
    assert.match(calendarBody, /opacity: 0\.4/);
    assert.match(candlestickBody, /opacity: 0\.4/);
  });

  it("each renderer carries the WD2-dim-echarts-rest marker for future grep-ability", () => {
    assert.match(sankeyBody, /WD2-dim-echarts-rest/);
    assert.match(calendarBody, /WD2-dim-echarts-rest/);
    assert.match(candlestickBody, /WD2-dim-echarts-rest/);
  });

  it("dim and dispatch share the same dispatch column per renderer (Sankey: sourceCh.field; Calendar: dateCh.field; Candlestick: xCh.field)", () => {
    // The dim membership check column must match the WD2-wiring-
    // echarts dispatch column for each renderer. A mismatch would
    // dim against a different column than the dispatch toggles,
    // producing a "dim but can't unfilter" inconsistency.
    assert.match(sankeyBody, /isCrossFilterActive\(dashboardFilters!, sourceCh\.field/);
    assert.match(calendarBody, /isCrossFilterActive\(dashboardFilters!, dateCh\.field/);
    assert.match(candlestickBody, /isCrossFilterActive\(dashboardFilters!, xCh\.field/);
  });
});
