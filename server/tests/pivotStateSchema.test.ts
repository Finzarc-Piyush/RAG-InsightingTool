/**
 * W-PivotState · pivotStateSchema contract
 *
 * Pins the round-trip shape so the client → PATCH → Cosmos → GET → client
 * pipeline remains structurally compatible. The schema is the single
 * source of truth (server/shared/schema.ts re-exported by the client),
 * so any breaking change here must also update DataPreviewTable
 * hydration and the agent context-summary blocks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { pivotStateSchema, messageSchema } = await import("../shared/schema.js");

describe("pivotStateSchema · round-trip contract", () => {
  it("accepts a fully-populated pivot state", () => {
    const ok = pivotStateSchema.safeParse({
      schemaVersion: 1,
      config: {
        rows: ["Region"],
        columns: [],
        values: [{ id: "v1", field: "Total_Sales", agg: "sum" }],
        filters: ["Category"],
        unused: ["OrderDate"],
        rowSort: { byValueSpecId: "v1", direction: "desc", primary: "measure" },
      },
      filterSelections: { Category: ["Office Supplies", "Technology"] },
      analysisView: "chart",
      chart: {
        type: "bar",
        xCol: "Region",
        yCol: "Total_Sales",
        seriesCol: "Category",
        barLayout: "stacked",
      },
    });
    assert.equal(ok.success, true);
  });

  it("accepts a minimal config without chart / view / filterSelections", () => {
    const ok = pivotStateSchema.safeParse({
      schemaVersion: 1,
      config: { rows: [], columns: [], values: [], filters: [], unused: [] },
    });
    assert.equal(ok.success, true);
  });

  it("rejects an unknown chart type", () => {
    const bad = pivotStateSchema.safeParse({
      schemaVersion: 1,
      config: { rows: [], columns: [], values: [], filters: [], unused: [] },
      chart: {
        type: "donut",
        xCol: "x",
        yCol: "y",
        seriesCol: "",
        barLayout: "stacked",
      },
    });
    assert.equal(bad.success, false);
  });

  it("rejects schemaVersion ≠ 1", () => {
    const bad = pivotStateSchema.safeParse({
      schemaVersion: 2,
      config: { rows: [], columns: [], values: [], filters: [], unused: [] },
    });
    assert.equal(bad.success, false);
  });

  it("messageSchema accepts an assistant message carrying pivotState", () => {
    const ok = messageSchema.safeParse({
      role: "assistant",
      content: "ok",
      timestamp: 123,
      pivotState: {
        schemaVersion: 1,
        config: {
          rows: ["A"],
          columns: [],
          values: [{ id: "v", field: "B", agg: "sum" }],
          filters: [],
          unused: [],
        },
        analysisView: "pivot",
      },
    });
    assert.equal(ok.success, true);
  });

  it("messageSchema accepts an assistant message without pivotState (back-compat)", () => {
    const ok = messageSchema.safeParse({
      role: "assistant",
      content: "ok",
      timestamp: 123,
    });
    assert.equal(ok.success, true);
  });
});
