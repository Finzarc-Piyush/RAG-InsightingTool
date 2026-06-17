import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChartSpec, DashboardSpec } from "../shared/schema.js";
import {
  applyDashboardTemplateLayout,
  chartGridItemsForTemplate,
} from "../lib/agents/runtime/dashboardTemplates.js";

const COLS = 12;

const chart = (over: Partial<ChartSpec> = {}): ChartSpec =>
  ({
    type: "bar",
    title: "c",
    x: "x",
    y: "y",
    ...over,
  }) as unknown as ChartSpec;

const charts = (n: number): ChartSpec[] =>
  Array.from({ length: n }, (_, i) => chart({ title: `c${i}`, x: `dim${i}` }));

/** Walk the items row by row; assert each row's widths sum to exactly COLS. */
function assertRowsFillGrid(items: { x: number; y: number; w: number }[]): void {
  const byRow = new Map<number, number>();
  for (const it of items) byRow.set(it.y, (byRow.get(it.y) ?? 0) + it.w);
  for (const [, sum] of byRow) assert.equal(sum, COLS, `row sum ${sum} == ${COLS}`);
}

const baseSpec = (
  template: DashboardSpec["template"],
  chartCount: number,
): DashboardSpec => ({
  name: "test",
  template,
  sheets: [
    { id: "sheet_summary", name: "Summary", narrativeBlocks: [] },
    { id: "sheet_evidence", name: "Evidence", charts: charts(chartCount) },
  ],
  defaultSheetId: "sheet_summary",
});

describe("chartGridItemsForTemplate (content-aware)", () => {
  it("returns undefined when there are no charts", () => {
    assert.equal(chartGridItemsForTemplate("executive", []), undefined);
  });

  it("executive: first chart is a full-width hero", () => {
    const items = chartGridItemsForTemplate("executive", charts(4))!;
    assert.equal(items.length, 4);
    assert.equal(items[0].x, 0);
    assert.equal(items[0].y, 0);
    assert.equal(items[0].w, COLS);
  });

  it("every template lays rows out so they fill the grid width (no orphan gap)", () => {
    for (const template of ["executive", "deep_dive", "monitoring"] as const) {
      for (const n of [1, 2, 3, 4, 5, 7]) {
        const items = chartGridItemsForTemplate(template, charts(n))!;
        assert.equal(items.length, n);
        assertRowsFillGrid(items);
      }
    }
  });

  it("a time-series chart gets a wider box than a small bar", () => {
    const mixed = [
      chart({ type: "line", x: "month" }), // wide appetite
      chart({ type: "pie", x: "seg" }), // standard appetite
      chart({ type: "scatter", x: "a" }), // standard appetite
    ];
    const items = chartGridItemsForTemplate("deep_dive", mixed)!;
    assert.ok(items[0].w > items[1].w, "line wider than pie");
  });

  it("monitoring seeds a compact height; non-monitoring sizes charts by width", () => {
    const mon = chartGridItemsForTemplate("monitoring", charts(3))!;
    for (const it of mon) assert.equal(it.h, 8);
    const exec = chartGridItemsForTemplate("executive", charts(4))!;
    // The full-width hero is taller than the narrower support charts, and every
    // chart height lands inside the aspect clamp [9, 16] (width-derived).
    assert.ok(exec[0].h > exec[1].h, `hero ${exec[0].h} > support ${exec[1].h}`);
    for (const it of exec) assert.ok(it.h >= 9 && it.h <= 16);
  });

  it("all generated items carry tile-compatible chart-<idx> ids", () => {
    const items = chartGridItemsForTemplate("deep_dive", charts(3))!;
    assert.deepEqual(
      items.map((i) => i.i),
      ["chart-0", "chart-1", "chart-2"],
    );
  });
});

describe("applyDashboardTemplateLayout", () => {
  it("populates sheet.gridLayout.lg when charts exist", () => {
    const spec = baseSpec("deep_dive", 4);
    applyDashboardTemplateLayout(spec);
    const evidence = spec.sheets.find((s) => s.id === "sheet_evidence")!;
    assert.ok(evidence.gridLayout?.lg);
    assert.equal(evidence.gridLayout!.lg!.length, 4);
  });

  it("leaves an existing lg layout untouched", () => {
    const spec = baseSpec("deep_dive", 2);
    const preset = [
      { i: "chart-0", x: 0, y: 0, w: 12, h: 20 },
      { i: "chart-1", x: 0, y: 20, w: 12, h: 20 },
    ];
    spec.sheets[1].gridLayout = { lg: preset };
    applyDashboardTemplateLayout(spec);
    assert.deepEqual(spec.sheets[1].gridLayout!.lg, preset);
  });

  it("skips sheets without charts", () => {
    const spec = baseSpec("monitoring", 0);
    applyDashboardTemplateLayout(spec);
    for (const sheet of spec.sheets) {
      assert.equal(sheet.gridLayout, undefined);
    }
  });
});
