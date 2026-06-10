/**
 * Wave MW4 · management-by-exception. computeAttentionAreas flags below-average
 * units from the dashboard's breakdown charts (org-average benchmark; >1 SD
 * below = red, else amber). Worst-first, skips trends / rollups / tiny / lower-
 * is-better metrics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeAttentionAreas } from "../lib/agents/runtime/computeAttentionAreas.js";

function rateChart(title: string, x: string, y: string, rows: Array<[string, number]>) {
  return { type: "bar", title, x, y, data: rows.map(([u, v]) => ({ [x]: u, [y]: v })) };
}

describe("MW4 · computeAttentionAreas", () => {
  it("flags below-average units, red for >1 SD below, worst-first", () => {
    // values: 0.9, 0.85, 0.8, 0.4  → mean 0.7375; the 0.4 is far below (red).
    const charts = [
      rateChart("PJP Adherence rate by ASM", "ASM", "PJP Adherence_rate", [
        ["A", 0.9],
        ["B", 0.85],
        ["C", 0.8],
        ["D", 0.4],
      ]),
    ];
    const out = computeAttentionAreas(charts);
    // Only below-mean units: D (0.4) and C (0.8 < 0.7375? no — 0.8 > 0.7375 → not flagged).
    assert.deepEqual(out.map((a) => a.unit), ["D"]);
    assert.equal(out[0].status, "red");
    assert.ok(out[0].variancePct < 0);
    assert.equal(out[0].dimension, "ASM");
  });

  it("marks the far-below unit red and the mildly-below unit amber", () => {
    const charts = [
      rateChart("Compliance rate by Cluster", "Cluster Name", "rate", [
        ["c1", 1.0],
        ["c2", 0.96],
        ["c3", 0.7],
        ["c4", 0.84],
      ]),
    ];
    const out = computeAttentionAreas(charts);
    // mean = 0.875, std ≈ 0.117, benchmark−1SD ≈ 0.758 → c3(0.70) red, c4(0.84) amber.
    const byUnit = Object.fromEntries(out.map((a) => [a.unit, a.status]));
    assert.equal(byUnit["c3"], "red");
    assert.equal(byUnit["c4"], "amber");
    // above-average clusters are not flagged.
    assert.ok(!("c1" in byUnit) && !("c2" in byUnit));
  });

  it("skips lower-is-better metrics (Non-Compliance) — below avg is good there", () => {
    const charts = [
      rateChart("Non-Compliance Visit (avg) by ASM", "ASM", "Non-Compliance Visit", [
        ["A", 10],
        ["B", 2],
        ["C", 3],
      ]),
    ];
    assert.deepEqual(computeAttentionAreas(charts), []);
  });

  it("skips trends, tiny breakdowns, and rollup rows", () => {
    const trend = { type: "line", title: "rate over time", x: "Day · Date", y: "rate", data: [{ "Day · Date": "1", rate: 0.5 }, { "Day · Date": "2", rate: 0.9 }] };
    const tiny = rateChart("rate by X", "X", "rate", [["a", 0.9], ["b", 0.1]]); // <3 units
    const withTotal = rateChart("rate by ASM", "ASM", "rate", [
      ["Total", 0.99],
      ["A", 0.8],
      ["B", 0.6],
      ["C", 0.7],
    ]);
    const out = computeAttentionAreas([trend as any, tiny, withTotal]);
    // trend + tiny skipped; "Total" rollup excluded; mean(0.8,0.6,0.7)=0.7 → B(0.6) below.
    assert.deepEqual(out.map((a) => a.unit), ["B"]);
  });

  it("caps to maxAreas, worst-first", () => {
    const rows: Array<[string, number]> = Array.from({ length: 10 }, (_, i) => [`u${i}`, i]); // 0..9
    const out = computeAttentionAreas([rateChart("m by D", "D", "v", rows)], { maxAreas: 2 });
    assert.equal(out.length, 2);
    // mean 4.5; worst-first → u0 (0) then u1 (1).
    assert.deepEqual(out.map((a) => a.unit), ["u0", "u1"]);
  });

  it("is a no-op on empty input", () => {
    assert.deepEqual(computeAttentionAreas([]), []);
  });
});
