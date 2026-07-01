import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatDocument } from "../models/chat.model.js";
import type { DataSummary } from "../shared/schema.js";
import { buildTileArtifact } from "../controllers/dashboardComposeController.js";

/**
 * Wave W5 (data-bound cards) · the compose artifact builder shared by the
 * /tiles/preview and /tiles/compose endpoints. Pins: the guardrail (sum-on-
 * ratio → 422), and correct scorecard / table / chart artifacts from a live
 * measure×agg×filter run over the session rows.
 */

const summary: DataSummary = {
  columns: [
    {
      name: "NR",
      type: "numeric",
      additivity: "additive",
      semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" },
    } as any,
    {
      name: "GC%",
      type: "numeric",
      additivity: "non_additive",
      additivityKind: "ratio_percent",
      semantics: { semanticType: "measure_ratio_percent", aggregation: "avg", displayKind: "numeric", source: "auto" },
    } as any,
    { name: "Channel", type: "text", uniqueValues: 2 } as any,
  ],
  numericColumns: ["NR", "GC%"],
  dateColumns: [],
  totalRows: 4,
  sampleRows: [],
} as any;

const ROWS = [
  { Channel: "GT", NR: 100, "GC%": 30 },
  { Channel: "GT", NR: 200, "GC%": 40 },
  { Channel: "MT", NR: 50, "GC%": 10 },
  { Channel: "MT", NR: 70, "GC%": 20 },
];

const chat = { dataSummary: summary, semanticModel: undefined } as unknown as ChatDocument;
const loadRows = async () => ROWS;
const ctx = { sessionId: "", chat, loadRows };

describe("W5 · buildTileArtifact guardrail", () => {
  it("SUM on a ratio measure → 422 with allowed aggregations", async () => {
    const art = await buildTileArtifact(
      {
        cardType: "scorecard",
        measure: { kind: "column", ref: "GC%", label: "GC%" },
        aggregation: "sum",
      } as any,
      ctx
    );
    assert.ok(!art.ok);
    if (art.ok) return;
    assert.equal(art.status, 422);
    assert.equal(art.error, "cannot_sum_non_additive");
    assert.deepEqual(art.allowed, ["avg"]);
  });
});

describe("W5 · buildTileArtifact produces artifacts", () => {
  it("scorecard (no temporal) → single total for GT = 300, currency/number format", async () => {
    const art = await buildTileArtifact(
      {
        cardType: "scorecard",
        measure: { kind: "column", ref: "NR", label: "Net Revenue" },
        aggregation: "sum",
        filters: [{ column: "Channel", op: "in", values: ["GT"] }],
        comparison: { mode: "none" },
      } as any,
      ctx
    );
    assert.ok(art.ok);
    if (!art.ok || art.cardType !== "scorecard") return;
    assert.equal(art.scorecard.snapshot?.value, 300);
    assert.equal(art.scorecard.metricPolarity, "higher_better");
    assert.ok(art.scorecard.cardDefinition, "carries the recompute recipe");
  });

  it("table → columns [Channel, NR] with a row per channel", async () => {
    const art = await buildTileArtifact(
      {
        cardType: "table",
        measure: { kind: "column", ref: "NR", label: "Net Revenue" },
        aggregation: "sum",
        groupBy: ["Channel"],
      } as any,
      ctx
    );
    assert.ok(art.ok);
    if (!art.ok || art.cardType !== "table") return;
    assert.deepEqual(art.table.columns, ["Channel", "NR"]);
    assert.equal(art.table.rows.length, 2);
  });

  it("chart → built ChartSpec carrying its cardDefinition", async () => {
    const art = await buildTileArtifact(
      {
        cardType: "chart",
        measure: { kind: "column", ref: "NR", label: "Net Revenue" },
        aggregation: "sum",
        groupBy: ["Channel"],
      } as any,
      ctx
    );
    assert.ok(art.ok);
    if (!art.ok || art.cardType !== "chart") return;
    assert.ok(art.chart.cardDefinition, "chart tile carries its recompute recipe");
    assert.equal(art.chart.cardDefinition?.cardType, "chart");
  });
});
