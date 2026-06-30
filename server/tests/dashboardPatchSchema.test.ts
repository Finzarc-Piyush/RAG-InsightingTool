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

describe("dashboardPatchSchema · editable Executive Summary band (Wave C1)", () => {
  it("accepts an answerEnvelope patch and preserves magnitudes + likelyDrivers (L-021)", () => {
    const parsed = dashboardPatchSchema.safeParse({
      answerEnvelope: {
        tldr: "Female survival far exceeds male.",
        magnitudes: [{ label: "female · survival rate", value: "74.2%" }],
        findings: [
          { headline: "Sex is the dominant split", evidence: "0.742 vs 0.189." },
        ],
        implications: [
          { statement: "Sex drives survival", soWhat: "Prioritise the lens." },
        ],
        likelyDrivers: [
          { explanation: "Lifeboat prioritisation", basis: "domain", confidence: "medium" },
        ],
        recommendations: [
          { action: "Keep sex as the headline cut", rationale: "Largest gap." },
        ],
      },
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      // The dashboard envelope object (NOT the message variant) keeps these
      // keys; a wrong-object parse would silently strip them.
      assert.equal(parsed.data.answerEnvelope?.magnitudes?.length, 1);
      assert.equal(parsed.data.answerEnvelope?.likelyDrivers?.length, 1);
    }
  });

  it("accepts an attentionAreas patch", () => {
    const parsed = dashboardPatchSchema.safeParse({
      attentionAreas: [
        {
          dimension: "Embarked",
          unit: "S",
          metric: "survival_rate by Embarked",
          value: 0.337,
          benchmark: 0.57,
          variancePct: -41,
          status: "red",
        },
      ],
    });
    assert.equal(parsed.success, true);
  });

  it("caps attentionAreas at 12", () => {
    const one = {
      dimension: "d",
      unit: "u",
      metric: "m",
      value: 1,
      benchmark: 2,
      variancePct: -10,
      status: "amber" as const,
    };
    const parsed = dashboardPatchSchema.safeParse({
      attentionAreas: Array.from({ length: 13 }, () => ({ ...one })),
    });
    assert.equal(parsed.success, false);
  });
});

describe("dashboardPatchSchema · free-form summary layout (W-SBGRID)", () => {
  it("accepts a summaryGridLayout patch keyed by breakpoint", () => {
    const parsed = dashboardPatchSchema.safeParse({
      summaryGridLayout: {
        lg: [
          { i: "mag_abc", x: 0, y: 0, w: 2, h: 3, minW: 1, minH: 2 },
          { i: "attn_def", x: 2, y: 0, w: 4, h: 4 },
        ],
        sm: [{ i: "mag_abc", x: 0, y: 0, w: 3, h: 3 }],
      },
    });
    assert.equal(parsed.success, true);
  });

  it("accepts per-card ids on summary items (stable grid keys)", () => {
    const parsed = dashboardPatchSchema.safeParse({
      answerEnvelope: {
        magnitudes: [{ label: "GT · NR", value: "470.92", tone: "green", id: "mag_abc" }],
        findings: [{ headline: "h", evidence: "e", id: "find_1" }],
        recommendations: [{ action: "a", rationale: "r", id: "rec_1" }],
        implications: [{ statement: "s", soWhat: "w", id: "imp_1" }],
        likelyDrivers: [
          { explanation: "x", basis: "data", confidence: "high", id: "drv_1" },
        ],
      },
      attentionAreas: [
        {
          dimension: "Embarked",
          unit: "S",
          metric: "m",
          value: 1,
          benchmark: 2,
          variancePct: -10,
          status: "amber",
          id: "attn_1",
        },
      ],
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.answerEnvelope?.magnitudes?.[0]?.id, "mag_abc");
      assert.equal(parsed.data.attentionAreas?.[0]?.id, "attn_1");
    }
  });
});
