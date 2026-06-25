import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_FEATURED_MAX,
  chartAngleKey,
  countDistinctAngles,
  chartWidthAppetite,
  decideFeaturedCount,
  selectFeaturedCharts,
  planChartLayout,
  chartRowsForSpan,
  chartRowsForChart,
} from "../shared/dashboardLayout.js";
import type { ChartSpec } from "../shared/schema.js";

function chart(p: Partial<ChartSpec>): ChartSpec {
  return {
    type: "bar",
    title: "Chart",
    x: "Region",
    y: "Sales",
    ...p,
  } as ChartSpec;
}

// --- angle identity ---------------------------------------------------------

test("chartAngleKey distinguishes metric, dimension, type, series", () => {
  const a = chart({ type: "bar", x: "Region", y: "Sales" });
  const b = chart({ type: "bar", x: "Region", y: "Profit" }); // different metric
  const c = chart({ type: "bar", x: "Region", y: "Sales" }); // exact repeat of a
  assert.notEqual(chartAngleKey(a), chartAngleKey(b));
  assert.equal(chartAngleKey(a), chartAngleKey(c));
});

test("countDistinctAngles dedupes exact repeats", () => {
  const charts = [
    chart({ x: "Region", y: "Sales" }),
    chart({ x: "Region", y: "Sales" }), // repeat
    chart({ x: "Brand", y: "Sales" }),
    chart({ type: "line", x: "Month", y: "Sales" }),
  ];
  assert.equal(countDistinctAngles(charts), 3);
});

// --- width appetite ---------------------------------------------------------

test("time-series and heatmap want to be wide; small bar/pie/scatter standard", () => {
  assert.equal(chartWidthAppetite(chart({ type: "line" })), "wide");
  assert.equal(chartWidthAppetite(chart({ type: "area" })), "wide");
  assert.equal(chartWidthAppetite(chart({ type: "heatmap" })), "wide");
  assert.equal(chartWidthAppetite(chart({ type: "pie" })), "standard");
  assert.equal(chartWidthAppetite(chart({ type: "scatter" })), "standard");
  assert.equal(chartWidthAppetite(chart({ type: "bar", data: [] })), "standard");
});

test("a bar with many categories or many series wants to be wide", () => {
  const manyCats = chart({ type: "bar", data: Array.from({ length: 20 }, () => ({})) });
  assert.equal(chartWidthAppetite(manyCats), "wide");
  const manySeries = chart({ type: "bar", seriesKeys: ["a", "b", "c", "d", "e"] });
  assert.equal(chartWidthAppetite(manySeries), "wide");
});

// --- featured count (the "not 3" fix) --------------------------------------

test("featured count follows the data, not a constant 3", () => {
  const six = Array.from({ length: 6 }, (_, i) => chart({ x: `Dim${i}`, y: "Sales" }));
  // 6 distinct angles, full depth → all 6 featured (was hard-capped at 3).
  assert.equal(decideFeaturedCount(six, { template: "executive", depthBudget: "full" }), 6);
});

test("featured count is bounded by the comfortable grid ceiling", () => {
  const many = Array.from({ length: 30 }, (_, i) => chart({ x: `Dim${i}`, y: "Sales" }));
  assert.equal(decideFeaturedCount(many, { template: "executive" }), GRID_FEATURED_MAX);
});

test("featured count collapses redundant repeats", () => {
  const dupes = Array.from({ length: 8 }, () => chart({ x: "Region", y: "Sales" }));
  assert.equal(decideFeaturedCount(dupes, { template: "executive" }), 1);
});

test("minimal depth keeps it lean; 0/1 charts pass through", () => {
  const four = Array.from({ length: 4 }, (_, i) => chart({ x: `Dim${i}` }));
  assert.equal(decideFeaturedCount(four, { depthBudget: "minimal" }), 3);
  assert.equal(decideFeaturedCount([], {}), 0);
  assert.equal(decideFeaturedCount([chart({})], {}), 1);
});

// --- selection --------------------------------------------------------------

test("selection leads with top-drivers then a time-series, deduped", () => {
  const charts = [
    chart({ title: "Sales by Brand", x: "Brand" }),
    chart({ type: "line", title: "Sales over time", x: "Month" }),
    chart({ title: "Top drivers of Sales", x: "Driver" }),
    chart({ title: "Sales by Region", x: "Region" }),
  ];
  const picked = selectFeaturedCharts(charts, 3);
  assert.equal(picked.length, 3);
  assert.match(picked[0]!.title!.toLowerCase(), /top drivers/);
  assert.equal(picked[1]!.type, "line");
});

// --- span planning + orphan avoidance --------------------------------------

test("inline 2-col: a lone trailing standard chart is stretched to fill (no orphan)", () => {
  // 3 small bars on a 2-col grid: row1 = [1,1], row2 = [1] → stretch to [2].
  const charts = [chart({ type: "bar" }), chart({ type: "bar" }), chart({ type: "bar" })];
  const plan = planChartLayout(charts, { columns: 2 });
  assert.deepEqual(plan.map((p) => p.span), [1, 1, 2]);
});

test("inline 2-col: a wide chart spans the full width", () => {
  const plan = planChartLayout([chart({ type: "line" }), chart({ type: "bar" }), chart({ type: "bar" })], {
    columns: 2,
  });
  assert.equal(plan[0]!.span, 2); // line = wide = full row
  assert.deepEqual(plan.slice(1).map((p) => p.span), [1, 1]);
});

test("12-col executive: hero is full width, the rest tile and the last row fills", () => {
  const charts = [
    chart({ type: "bar" }), // hero
    chart({ type: "bar" }),
    chart({ type: "bar" }),
    chart({ type: "bar" }),
  ];
  const plan = planChartLayout(charts, { columns: 12, emphasizeFirst: true });
  assert.equal(plan[0]!.span, 12);
  assert.equal(plan[0]!.emphasis, "hero");
  // remaining 3 standard charts → 4+4+4 = 12, last row already full.
  assert.deepEqual(plan.slice(1).map((p) => p.span), [4, 4, 4]);
});

// --- chart height by width --------------------------------------------------

test("chartRowsForSpan: wider boxes are taller, clamped to [11,16]", () => {
  const narrow = chartRowsForSpan(4); // third-width
  const wide = chartRowsForSpan(8);
  const hero = chartRowsForSpan(12); // full-width
  assert.ok(narrow <= wide && wide <= hero, `monotonic: ${narrow} <= ${wide} <= ${hero}`);
  for (const span of [1, 2, 4, 6, 8, 12]) {
    const rows = chartRowsForSpan(span);
    assert.ok(rows >= 11 && rows <= 16, `span ${span} → ${rows} in [11,16]`);
  }
  // A full-width hero reserves clearly more height than a third-width box.
  assert.ok(hero > narrow);
});

// --- chart height by TYPE (bar gets a taller floor) -------------------------

test("chartRowsForChart: a narrow bar is taller than the same-width line", () => {
  const span = 4; // third-width — where the aspect height is shortest
  const lineRows = chartRowsForChart(chart({ type: "line" }), span);
  const barRows = chartRowsForChart(chart({ type: "bar", data: [{}, {}] }), span);
  // Non-bar keeps the pure aspect height.
  assert.equal(lineRows, chartRowsForSpan(span));
  // A bar is floored taller so its categories stay readable on the grid.
  assert.ok(barRows > lineRows, `bar ${barRows} > line ${lineRows}`);
  assert.ok(barRows >= 12, `bar floor ${barRows} >= 12`);
});

test("chartRowsForChart: a many-category bar is tallest", () => {
  const span = 4;
  const fewCats = chartRowsForChart(chart({ type: "bar", data: [{}, {}] }), span);
  const manyCats = chartRowsForChart(
    chart({ type: "bar", data: Array.from({ length: 20 }, () => ({})) }),
    span,
  );
  assert.ok(manyCats > fewCats, `many ${manyCats} > few ${fewCats}`);
  assert.ok(manyCats >= 14, `many-category bar floor ${manyCats} >= 14`);
});

test("chartRowsForChart: the bar floor never exceeds maxRows", () => {
  // A tiny clamp window must still cap the bar floor.
  const rows = chartRowsForChart(chart({ type: "bar", data: Array.from({ length: 20 }, () => ({})) }), 4, {
    maxRows: 10,
  });
  assert.ok(rows <= 10, `bar floor respects maxRows: ${rows} <= 10`);
});

test("chartRowsForSpan: honours custom geometry + clamps", () => {
  // Tiny clamp window pins the output regardless of width.
  assert.equal(chartRowsForSpan(12, { minRows: 5, maxRows: 5 }), 5);
});

test("every row sums to exactly the grid width (rows are aligned)", () => {
  for (const cols of [2, 12]) {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const charts = Array.from({ length: n }, () => chart({ type: "bar" }));
      const plan = planChartLayout(charts, { columns: cols, emphasizeFirst: cols === 12 });
      // Walk rows; assert each completed row equals cols and the final row too.
      let acc = 0;
      const rowSums: number[] = [];
      for (const it of plan) {
        assert.ok(it.span >= 1 && it.span <= cols, `span ${it.span} in [1,${cols}]`);
        if (acc + it.span > cols) {
          rowSums.push(acc);
          acc = it.span;
        } else {
          acc += it.span;
        }
      }
      rowSums.push(acc);
      for (const sum of rowSums) assert.equal(sum, cols, `row sum ${sum} == ${cols} (n=${n})`);
    }
  }
});
