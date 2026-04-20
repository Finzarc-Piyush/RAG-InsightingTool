import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  dashboardPatchSchema,
  patchDashboardRequestSchema,
  type DashboardPatch,
} from "../shared/schema.js";

const minimalChart = () =>
  ({
    type: "bar",
    title: "Sales by region",
    x: "region",
    y: "sales_sum",
  }) as unknown;

describe("dashboardPatchSchema (Phase 2.E)", () => {
  it("accepts an empty patch (no-op)", () => {
    const parsed = dashboardPatchSchema.safeParse({});
    assert.equal(parsed.success, true);
  });

  it("accepts addCharts with a target sheetId", () => {
    const patch: DashboardPatch = {
      addCharts: [{ chart: minimalChart() as any, sheetId: "sheet_evidence" }],
    };
    const parsed = dashboardPatchSchema.safeParse(patch);
    assert.equal(parsed.success, true);
  });

  it("accepts removeCharts by (sheetId, chartIndex)", () => {
    const parsed = dashboardPatchSchema.safeParse({
      removeCharts: [{ sheetId: "sheet_evidence", chartIndex: 2 }],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects a negative chartIndex", () => {
    const parsed = dashboardPatchSchema.safeParse({
      removeCharts: [{ sheetId: "a", chartIndex: -1 }],
    });
    assert.equal(parsed.success, false);
  });

  it("caps addCharts at 8", () => {
    const parsed = dashboardPatchSchema.safeParse({
      addCharts: Array.from({ length: 9 }, () => ({
        chart: minimalChart() as any,
      })),
    });
    assert.equal(parsed.success, false);
  });

  it("accepts renameSheet with non-empty name", () => {
    const parsed = dashboardPatchSchema.safeParse({
      renameSheet: { sheetId: "sheet_summary", name: "Overview" },
    });
    assert.equal(parsed.success, true);
  });

  it("rejects renameSheet with empty name", () => {
    const parsed = dashboardPatchSchema.safeParse({
      renameSheet: { sheetId: "sheet_summary", name: "" },
    });
    assert.equal(parsed.success, false);
  });

  it("round-trips via patchDashboardRequestSchema", () => {
    const parsed = patchDashboardRequestSchema.safeParse({
      patch: {
        addCharts: [{ chart: minimalChart() as any }],
        removeCharts: [{ sheetId: "sheet_evidence", chartIndex: 0 }],
        renameSheet: { sheetId: "sheet_summary", name: "Exec summary" },
      },
    });
    assert.equal(parsed.success, true);
  });
});
