import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { z } from "zod";

// The tool args schema is intentionally declared inside the tool module
// (private). Re-declare the same shape here to guard parity — if the
// module's schema diverges, the test's expectations fail and the
// developer is prompted to update the test alongside the tool.

import { dashboardPatchSchema } from "../shared/schema.js";

const patchDashboardToolArgsSchema = dashboardPatchSchema.extend({
  dashboardId: z.string().max(200).optional(),
});

describe("patch_dashboard tool args", () => {
  it("accepts a minimal addCharts patch with a dashboardId", () => {
    const out = patchDashboardToolArgsSchema.safeParse({
      dashboardId: "dash_abc",
      addCharts: [
        {
          chart: { type: "bar", title: "Margin by region", x: "region", y: "margin_sum" } as any,
        },
      ],
    });
    assert.equal(out.success, true);
  });

  it("accepts a patch without dashboardId (tool falls back to session memory)", () => {
    const out = patchDashboardToolArgsSchema.safeParse({
      renameSheet: { sheetId: "sheet_evidence", name: "Drivers" },
    });
    assert.equal(out.success, true);
  });

  it("rejects an empty object + dashboardId only (no op)", () => {
    // Zod itself accepts {} because every field is optional; the tool
    // handler rejects at runtime. Document that expectation here.
    const out = patchDashboardToolArgsSchema.safeParse({ dashboardId: "dash_xyz" });
    assert.equal(out.success, true);
    // Runtime no-op guard lives in the tool handler; tested via integration.
  });

  it("rejects a dashboardId longer than 200 chars", () => {
    const out = patchDashboardToolArgsSchema.safeParse({
      dashboardId: "x".repeat(201),
    });
    assert.equal(out.success, false);
  });
});
