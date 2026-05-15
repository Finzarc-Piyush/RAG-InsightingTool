import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTemporalTrendBuckets } from "../lib/agents/runtime/checkTemporalTrendBuckets.js";
import type { StructuredObservation } from "../lib/agents/runtime/investigationState.js";

/**
 * Wave T3 · safety-net gate for "user asked for a temporal trend but the
 * executed query returned only one time bucket". Mirrors the W17 / W22 / W35
 * envelope-check shape; pure logic, no LLM.
 */

function makeObs(opts: {
  groupBy: string[];
  rows: Record<string, unknown>[];
}): StructuredObservation {
  return {
    id: "obs-1",
    stepId: "s1",
    tool: "execute_query_plan",
    args: { plan: { groupBy: opts.groupBy, aggregations: [] } },
    result: { table: { rows: opts.rows } },
    resultSummary: "",
    metrics: {},
    findingIds: [],
    createdAt: Date.now(),
  };
}

describe("checkTemporalTrendBuckets", () => {
  it("passes when question doesn't ask for a trend", () => {
    const obs = makeObs({
      groupBy: ["Month · Order Date"],
      rows: [{ "Month · Order Date": "2026-04", v: 1 }],
    });
    const r = checkTemporalTrendBuckets("Top 5 products by revenue", [obs]);
    assert.equal(r.ok, true);
  });

  it("passes when user said 'daily' explicitly (user intent honoured)", () => {
    const obs = makeObs({
      groupBy: ["Day · Order Date"],
      rows: [{ "Day · Order Date": "2026-04-01", v: 1 }],
    });
    const r = checkTemporalTrendBuckets("Daily sales trend", [obs]);
    assert.equal(r.ok, true);
  });

  it("passes when there's no execute_query_plan observation", () => {
    const r = checkTemporalTrendBuckets("Sales trend over time", []);
    assert.equal(r.ok, true);
  });

  it("passes when groupBy contains no temporal facet", () => {
    const obs = makeObs({
      groupBy: ["Region", "Cluster Name"],
      rows: [
        { Region: "North", "Cluster Name": "Cluster_1_NORTH", v: 1 },
        { Region: "South", "Cluster Name": "Cluster_1_SOUTH", v: 2 },
      ],
    });
    const r = checkTemporalTrendBuckets("Sales trend over time", [obs]);
    assert.equal(r.ok, true);
  });

  it("passes when the temporal facet has multiple distinct buckets", () => {
    const obs = makeObs({
      groupBy: ["Month · Order Date", "Region"],
      rows: [
        { "Month · Order Date": "2026-04", Region: "N", v: 1 },
        { "Month · Order Date": "2026-05", Region: "N", v: 2 },
        { "Month · Order Date": "2026-06", Region: "N", v: 3 },
      ],
    });
    const r = checkTemporalTrendBuckets("Sales trend over time", [obs]);
    assert.equal(r.ok, true);
  });

  it("FIRES when trend question + 1 distinct temporal bucket (Marico failure case)", () => {
    // Exact shape of the failure that prompted this gate: 8 cluster rows,
    // all at the single Month · Date = "2026-04" bucket.
    const obs = makeObs({
      groupBy: ["Month · Date", "Cluster Name"],
      rows: [
        { "Month · Date": "2026-04", "Cluster Name": "Cluster_1_EAST", v: 8531 },
        { "Month · Date": "2026-04", "Cluster Name": "Cluster_1_NORTH", v: 10742 },
        { "Month · Date": "2026-04", "Cluster Name": "Cluster_1_SOUTH", v: 15132 },
        { "Month · Date": "2026-04", "Cluster Name": "Cluster_1_WEST", v: 14305 },
      ],
    });
    const r = checkTemporalTrendBuckets(
      "How do compliance visits vary across clusters over time?",
      [obs],
    );
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "TEMPORAL_TREND_SINGLE_BUCKET");
    assert.ok(r.description.includes("Month · Date"));
    assert.ok(r.description.includes("2026-04"));
    assert.ok(r.courseCorrection.includes("caveats"));
  });

  it("FIRES when the temporal facet column has zero non-null buckets", () => {
    const obs = makeObs({
      groupBy: ["Month · Date"],
      rows: [
        { "Month · Date": null, v: 1 },
        { "Month · Date": "", v: 2 },
      ],
    });
    const r = checkTemporalTrendBuckets("Sales trend over time", [obs]);
    assert.equal(r.ok, false);
  });

  it("uses the MOST RECENT execute_query_plan observation when multiple exist", () => {
    // Earlier obs: a different tool — skipped.
    const earlier: StructuredObservation = {
      id: "obs-0",
      stepId: "s0",
      tool: "run_correlation",
      args: {},
      result: { table: { rows: [] } },
      resultSummary: "",
      metrics: {},
      findingIds: [],
      createdAt: 1,
    };
    // Earlier execute_query_plan: returned multiple buckets — would pass alone.
    const earlierQp = makeObs({
      groupBy: ["Month · Date"],
      rows: [
        { "Month · Date": "2026-03", v: 1 },
        { "Month · Date": "2026-04", v: 2 },
      ],
    });
    // Most recent execute_query_plan: single bucket — should drive the gate.
    const latest = makeObs({
      groupBy: ["Month · Date"],
      rows: [{ "Month · Date": "2026-04", v: 9 }],
    });
    const r = checkTemporalTrendBuckets("Sales trend over time", [
      earlier,
      earlierQp,
      latest,
    ]);
    assert.equal(r.ok, false);
  });

  it("handles result.table as a bare array (alternate ToolResult shape)", () => {
    const obs: StructuredObservation = {
      id: "obs-1",
      stepId: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Month · Date"] } },
      result: {
        table: [
          { "Month · Date": "2026-04", v: 1 },
          { "Month · Date": "2026-04", v: 2 },
        ],
      },
      resultSummary: "",
      metrics: {},
      findingIds: [],
      createdAt: Date.now(),
    };
    const r = checkTemporalTrendBuckets("Sales trend over time", [obs]);
    assert.equal(r.ok, false);
  });
});
