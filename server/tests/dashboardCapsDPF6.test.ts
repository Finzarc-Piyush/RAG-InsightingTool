import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAllArtefactsNarrativeBlocks } from "../lib/agents/runtime/buildDashboard.js";
import { __test__ as featureSweepInternals } from "../lib/agents/runtime/dashboardFeatureSweep.js";
import { dashboardSheetSpecSchema } from "../shared/schema.js";

/**
 * DPF6 · pin the cap raises that close the "not all charts/insights flow
 * to the dashboard" gap when a user explicitly asks for a dashboard
 * (sales / HR / attrition / marketing / finance / etc).
 *
 * Pre-DPF6 caps (silently dropped content):
 *   - AGENT_MAX_FINAL_CHARTS_PER_TURN default = 14
 *   - DASHBOARD_CHART_HARD_CAP                 = 18
 *   - DEFAULT_MAX_SWEEP_CHARTS                 = 18
 *   - intermediateSummaries.slice(0, 8)        = 8 narrative blocks max
 *
 * Post-DPF6 caps (aligned to the per-sheet schema ceiling):
 *   - AGENT_MAX_FINAL_CHARTS_PER_TURN default = 24
 *   - DASHBOARD_CHART_HARD_CAP                 = 24
 *   - DEFAULT_MAX_SWEEP_CHARTS                 = 24
 *   - intermediateSummaries.slice(0, 30)       = 30 narrative blocks max
 *
 * Why 24 / 30 specifically:
 *   - 24 is the per-sheet `dashboardSheetSpecSchema.charts.max()` ceiling
 *     so no runtime cap re-trims below the schema.
 *   - 30 stays well below `dashboardSheetSpecSchema.narrativeBlocks.max(40)`
 *     leaving headroom for the KPI strip + LLM-curated narrative blocks
 *     while no longer truncating long planner traces (12-20 tool calls
 *     is typical for a comprehensive dashboard turn).
 *
 * Operators can still tighten via env (`AGENT_MAX_FINAL_CHARTS_PER_TURN`).
 * The default is what mattered — it's now consistent with the schema.
 */

/**
 * Wave DR17 · the previous DPF6 contract was "emit one Step N block
 * per intermediate tool summary, capped at 30". Users called this out
 * as noise — those blocks dump raw tool-call internals
 * (`get_schema_summary: rows=9800 columns=…`,
 * `execute_query_plan: Grouped by Region with sum(Sales)…`) onto the
 * All Artefacts sheet, which is supposed to be a clean ledger of
 * charts and tables, not an audit log.
 *
 * The current contract is the inverse: `buildAllArtefactsNarrativeBlocks`
 * MUST always return an empty array. Any other behaviour leaks
 * tool-call audit data into a user-facing dashboard. This block
 * exists as a regression guard against re-introduction.
 */
describe("DR17 · buildAllArtefactsNarrativeBlocks never emits Step blocks", () => {
  it("returns [] for empty / undefined input", () => {
    assert.deepEqual(buildAllArtefactsNarrativeBlocks(undefined), []);
    assert.deepEqual(buildAllArtefactsNarrativeBlocks([]), []);
  });

  it("returns [] even when intermediate summaries exist", () => {
    const summaries = Array.from({ length: 30 }, (_, i) => `tool_${i}: summary line`);
    assert.deepEqual(buildAllArtefactsNarrativeBlocks(summaries), []);
  });

  it("returns [] for the worst-case 50-summary input (defensive, no leak under runaway planners)", () => {
    const summaries = Array.from({ length: 50 }, (_, i) => `tool_${i}: line`);
    assert.deepEqual(buildAllArtefactsNarrativeBlocks(summaries), []);
  });

  it("returns [] for very long single summaries (no truncated leak)", () => {
    const long = "x".repeat(2000);
    assert.deepEqual(buildAllArtefactsNarrativeBlocks([long]), []);
  });

  it("documents that the per-sheet narrativeBlocks ceiling stays headroom for Sheet 1 KPI / LLM blocks", () => {
    // The All Artefacts sheet now contributes zero narrative blocks; the
    // schema's per-sheet ceiling of 40 is reserved entirely for Sheet 1
    // (KPI strip + LLM-curated narrative + post-DR6 user notes).
    const schemaCap = (dashboardSheetSpecSchema.shape.narrativeBlocks as unknown as {
      _def: { innerType: { _def: { maxLength: { value: number } } } };
    })._def.innerType._def.maxLength?.value;
    if (typeof schemaCap === "number") {
      assert.ok(schemaCap >= 1, "schema cap must remain positive");
    }
  });
});

describe("DPF6 · dashboardFeatureSweep DEFAULT_MAX_SWEEP_CHARTS aligned with hard cap", () => {
  it("default ceiling is 24 (raised from 18 — schema-matched)", () => {
    assert.equal(featureSweepInternals.DEFAULT_MAX_SWEEP_CHARTS, 24);
  });
});

describe("DPF6 · finalizeMergedCharts default cap is 24 (raised from 14)", () => {
  // The function isn't directly exported (it mutates an internal
  // mergedCharts array inside the agent loop), so we pin the
  // observable contract via env-var default + module-level constant
  // mention. The agent loop tests already exercise the cap via
  // dashboard regression suites; this test pins that the default
  // we ship is 24, matching `DASHBOARD_CHART_HARD_CAP` and the
  // per-sheet schema ceiling.
  it("source comment + default value match (regression guard)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = await fs.readFile(
      path.resolve(here, "../lib/agents/runtime/agentLoop.service.ts"),
      "utf8"
    );
    // Two distinct sites must both read 24 (parsing the env, and the
    // fallback when the env is missing/invalid).
    const matches = src.match(/parseInt\(capRaw, 10\) : 24[\s\S]*?\? cap : 24/);
    assert.ok(
      matches,
      "finalizeMergedCharts must default to 24 (DPF6 raise from 14)"
    );
    // DASHBOARD_CHART_HARD_CAP must also be 24 so the sweep budget
    // (`remaining = HARD_CAP - mergedCharts.length`) lines up with
    // finalizeMergedCharts — no silent re-trim below the sweep's emit.
    assert.ok(
      /const DASHBOARD_CHART_HARD_CAP = 24;/.test(src),
      "DASHBOARD_CHART_HARD_CAP must be 24 (DPF6 raise from 18)"
    );
  });
});
