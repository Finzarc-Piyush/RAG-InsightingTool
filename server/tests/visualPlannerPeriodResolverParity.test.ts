/**
 * Wave W-GMK3 (updated 2026-06-14) · drift-defence: the visual-planner
 * deterministic fallback MUST produce the SAME chart as `chartFromTable.ts`'s
 * `buildChartFromAnalyticalTable` from the same `ctx.lastAnalyticalTable`.
 *
 * Originally this was enforced by source-inspecting that the fallback mirrored
 * `chartFromTable`'s `resolvePeriodAxis` x-axis selector line-for-line. The two
 * paths have since been MERGED: the fallback now *calls* `buildChartFromAnalyticalTable`
 * outright (see docs/decisions/duplication-audit-deferrals.md — the deferred full
 * merge, now done), so parity is structural, not copied. This test pins the
 * delegation (the tripwire) AND asserts runtime equivalence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildDeterministicFallbackChart } from "../lib/agents/runtime/visualPlanner.js";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../lib/agents/runtime/visualPlanner.ts"),
  "utf8"
);

describe("W-GMK3 · visualPlanner deterministic fallback delegates to chartFromTable", () => {
  it("imports buildChartFromAnalyticalTable from the shared promotion builder", () => {
    assert.match(
      src,
      /from\s+"\.\/chartFromTable\.js"/,
      "visualPlanner.ts must import from chartFromTable.ts (the shared builder)"
    );
    assert.match(src, /\bbuildChartFromAnalyticalTable\b/);
  });

  it("the deterministic fallback CALLS buildChartFromAnalyticalTable (no re-implemented x-pick)", () => {
    assert.match(src, /buildChartFromAnalyticalTable\(\{/);
    // The old inline `const x = dimCols[0]!` rule and a private resolvePeriodAxis
    // call must be gone — the fallback no longer rolls its own axis logic.
    assert.doesNotMatch(src, /^\s*const x = dimCols\[0\]!;\s*$/m);
    assert.doesNotMatch(src, /\bresolvePeriodAxis\b/);
  });

  it("re-applies the ctx-aware validateChartProposal guard before shipping", () => {
    assert.match(
      src,
      /buildDeterministicFallbackChart[\s\S]+?validateChartProposal\(/,
      "the fallback must still run validateChartProposal on the built spec"
    );
  });

  it("runtime: fallback chart is byte-identical to buildChartFromAnalyticalTable", () => {
    const table = {
      rows: [
        { Region: "North", sales_sum: 1200 },
        { Region: "South", sales_sum: 800 },
        { Region: "West", sales_sum: 1500 },
      ],
      columns: ["Region", "sales_sum"],
    };
    const summary: DataSummary = {
      rowCount: 3,
      columnCount: 2,
      columns: [
        { name: "Region", type: "string", sampleValues: [] },
        { name: "sales_sum", type: "number", sampleValues: [] },
      ],
      numericColumns: ["sales_sum"],
      dateColumns: [],
    } as unknown as DataSummary;
    const direct = buildChartFromAnalyticalTable({
      table,
      summary,
      question: "sales by region",
    });
    const ctx = {
      sessionId: "s",
      question: "sales by region",
      data: table.rows,
      turnStartDataRef: table.rows,
      summary,
      chatHistory: [],
      mode: "analysis",
      lastAnalyticalTable: { columns: table.columns, rows: table.rows },
    } as unknown as AgentExecutionContext;
    const fallback = buildDeterministicFallbackChart(ctx, []);
    assert.notEqual(direct, null);
    assert.notEqual(fallback, null);
    assert.deepEqual(fallback!.charts[0], direct);
  });
});
