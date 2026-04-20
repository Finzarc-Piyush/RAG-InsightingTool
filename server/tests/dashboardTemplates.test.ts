import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChartSpec, DashboardSpec } from "../shared/schema.js";
import {
  applyDashboardTemplateLayout,
  chartGridItemsForTemplate,
} from "../lib/agents/runtime/dashboardTemplates.js";

const chart = (title: string): ChartSpec =>
  ({
    type: "bar",
    title,
    x: "x",
    y: "y",
  }) as unknown as ChartSpec;

const baseSpec = (
  template: DashboardSpec["template"],
  chartCount: number
): DashboardSpec => ({
  name: "test",
  template,
  sheets: [
    {
      id: "sheet_summary",
      name: "Summary",
      narrativeBlocks: [],
    },
    {
      id: "sheet_evidence",
      name: "Evidence",
      charts: Array.from({ length: chartCount }, (_, i) => chart(`c${i}`)),
    },
  ],
  defaultSheetId: "sheet_summary",
});

describe("chartGridItemsForTemplate", () => {
  it("returns undefined when there are no charts", () => {
    assert.equal(chartGridItemsForTemplate("executive", 0), undefined);
  });

  it("executive: first chart is a full-width hero, remaining in a 2-column grid", () => {
    const items = chartGridItemsForTemplate("executive", 3)!;
    assert.equal(items.length, 3);
    assert.deepEqual(
      { x: items[0].x, y: items[0].y, w: items[0].w, h: items[0].h },
      { x: 0, y: 0, w: 12, h: 12 }
    );
    // Two support charts, side-by-side below the hero.
    assert.equal(items[1].y, 12);
    assert.equal(items[1].w, 6);
    assert.equal(items[2].y, 12);
    assert.equal(items[2].x, 6);
  });

  it("deep_dive: uniform 2-column grid", () => {
    const items = chartGridItemsForTemplate("deep_dive", 6)!;
    assert.equal(items.length, 6);
    for (const item of items) {
      assert.equal(item.w, 6);
      assert.equal(item.h, 12);
    }
    // Third chart starts a new row.
    assert.equal(items[2].y, 12);
  });

  it("monitoring: uniform 3-column compact grid", () => {
    const items = chartGridItemsForTemplate("monitoring", 4)!;
    for (const item of items) {
      assert.equal(item.w, 4);
      assert.equal(item.h, 8);
    }
    // Fourth chart wraps to a new row.
    assert.equal(items[3].y, 8);
    assert.equal(items[3].x, 0);
  });

  it("all generated items carry tile-compatible chart-<idx> ids", () => {
    const items = chartGridItemsForTemplate("deep_dive", 3)!;
    assert.deepEqual(
      items.map((i) => i.i),
      ["chart-0", "chart-1", "chart-2"]
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
