/**
 * W55 · cross-wave pipeline test.
 *
 * Proves the contract chain W46 → W53 → W54 holds end-to-end:
 *   - W46 tagger correctly identifies spend / outcome / time on a realistic
 *     marketing-mix DataSummary.
 *   - W53 tool calls the Python bridge with the tagged columns and constructs
 *     charts + insights from the response.
 *   - W54 adapter turns the tool's operationResult into deterministic
 *     answerEnvelope.recommendations and magnitudes.
 *
 * Python is not exercised here — `runBudgetRedistribute` is fed a fake but
 * shape-correct response. The Python math is verified separately via
 * python-service/tests/{test_fit.py, test_optimize.py}.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tagMarketingColumns,
  looksLikeMarketingMixDataset,
} from "../lib/marketingColumnTags.js";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerBudgetOptimizerTool } from "../lib/agents/runtime/tools/budgetOptimizerTool.js";
import {
  isBudgetRedistributeOperationResult,
  buildRecommendationsFromBudgetOptimizer,
  buildMagnitudesFromBudgetOptimizer,
  buildDomainLensFromBudgetOptimizer,
} from "../lib/agents/runtime/budgetOptimizerAdapter.js";
import type {
  BudgetRedistributeResponse,
  MmmFetcher,
} from "../lib/dataOps/mmmService.js";
import type { DataSummary } from "../shared/schema.js";
import { looksLikeBudgetReallocationQuestion } from "../lib/agents/runtime/analysisBrief.js";

function syntheticMmmSummary(): DataSummary {
  return {
    rowCount: 80,
    columnCount: 5,
    columns: [
      { name: "Week", type: "date", sampleValues: ["2024-01-01"] },
      { name: "TV_Spend", type: "number", sampleValues: [12000, 14500, 9800] },
      { name: "Digital_Spend", type: "number", sampleValues: [8500, 6200, 11000] },
      { name: "OOH_Spend", type: "number", sampleValues: [3200, 4100, 2800] },
      { name: "Revenue", type: "number", sampleValues: [42000, 45000, 39000] },
    ],
    numericColumns: ["TV_Spend", "Digital_Spend", "OOH_Spend", "Revenue"],
    dateColumns: ["Week"],
  };
}

function syntheticRows(): Record<string, any>[] {
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < 80; i++) {
    rows.push({
      Week: new Date(2024, 0, 1 + i * 7).toISOString().slice(0, 10),
      TV_Spend: 10000 + (i % 10) * 500,
      Digital_Spend: 7000 + (i % 7) * 400,
      OOH_Spend: 3000 + (i % 5) * 200,
      Revenue: 40000 + (i % 13) * 800,
    });
  }
  return rows;
}

function realisticPythonResponse(): BudgetRedistributeResponse {
  return {
    channels: [
      {
        name: "TV_Spend", decay: 0.5, k: 11000, alpha: 1.5, beta: 0.85,
        elasticity: 0.41, elasticity_ci95: [0.32, 0.51],
        current_total_spend: 1_200_000, optimal_total_spend: 1_440_000, delta_pct: 20,
      },
      {
        name: "Digital_Spend", decay: 0.2, k: 8000, alpha: 1.0, beta: 0.55,
        elasticity: 0.18, elasticity_ci95: [0.10, 0.27],
        current_total_spend: 800_000, optimal_total_spend: 640_000, delta_pct: -20,
      },
      {
        name: "OOH_Spend", decay: 0.1, k: 3500, alpha: 2.0, beta: 0.30,
        elasticity: 0.06, elasticity_ci95: [0.0, 0.12],
        current_total_spend: 400_000, optimal_total_spend: 320_000, delta_pct: -20,
      },
    ],
    current_allocation: { TV_Spend: 1_200_000, Digital_Spend: 800_000, OOH_Spend: 400_000 },
    optimal_allocation: { TV_Spend: 1_440_000, Digital_Spend: 640_000, OOH_Spend: 320_000 },
    current_outcome: 3_400_000, optimal_outcome: 3_672_000, projected_lift_pct: 8.0,
    converged: true, iterations: 32,
    bounds_used: {
      TV_Spend: [600_000, 2_400_000],
      Digital_Spend: [400_000, 1_600_000],
      OOH_Spend: [200_000, 800_000],
    },
    total_budget_used: 2_400_000,
    fit_metrics: { r_squared: 0.78, rmse: 12000, n_observations: 80, max_pairwise_vif: 2.1 },
    model_caveats: [],
    response_curves: {
      TV_Spend:      { x: [0, 600_000, 1_200_000, 1_800_000, 2_400_000], y: [0, 0.4, 0.6, 0.7, 0.75], current_x: 1_200_000, optimal_x: 1_440_000 },
      Digital_Spend: { x: [0, 400_000, 800_000, 1_200_000, 1_600_000], y: [0, 0.30, 0.45, 0.52, 0.55], current_x: 800_000, optimal_x: 640_000 },
      OOH_Spend:     { x: [0, 200_000, 400_000, 600_000, 800_000], y: [0, 0.10, 0.18, 0.22, 0.24], current_x: 400_000, optimal_x: 320_000 },
    },
  };
}

describe("budget-optimizer cross-wave pipeline (W46 → W53 → W54)", () => {
  it("end-to-end: tag → tool → adapter produces a complete answer envelope", async () => {
    const summary = syntheticMmmSummary();
    const data = syntheticRows();
    const userQ = "How should I redistribute my marketing budget across TV, digital, and OOH?";

    // (1) W52 intent detector
    assert.equal(looksLikeBudgetReallocationQuestion(userQ), true);

    // (2) W46 tagger
    assert.equal(looksLikeMarketingMixDataset(summary), true);
    const tagged = tagMarketingColumns(summary);
    assert.deepEqual(tagged.spendColumns.sort(), ["Digital_Spend", "OOH_Spend", "TV_Spend"]);
    assert.equal(tagged.outcomeColumn, "Revenue");
    assert.equal(tagged.timeColumn, "Week");
    assert.equal(tagged.shape, "wide");

    // (3) W53 tool — fetcher returns realistic Python response
    const reg = new ToolRegistry();
    const fetcher: MmmFetcher = async (path, init) => {
      assert.equal(path, "/mmm/budget-redistribute");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.deepEqual(body.spend_columns.sort(), ["Digital_Spend", "OOH_Spend", "TV_Spend"]);
      assert.equal(body.outcome_column, "Revenue");
      assert.equal(body.time_column, "Week");
      return new Response(JSON.stringify(realisticPythonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    registerBudgetOptimizerTool(reg, { fetcher });
    const ctx = { exec: { mode: "analysis", summary, data }, config: {} } as any;
    const toolOut = await reg.execute("run_budget_optimizer", {}, ctx);

    assert.equal(toolOut.ok, true);
    assert.ok(toolOut.charts && toolOut.charts.length === 4);
    assert.equal(toolOut.charts![0].type, "bar");
    assert.equal(toolOut.charts![0].title, "Current vs optimal budget allocation");
    // Response-curve charts carry current + optimal reference lines
    const curveChart = toolOut.charts![1];
    assert.equal(curveChart.type, "line");
    const layers = curveChart._autoLayers ?? [];
    assert.ok(layers.some((l) => l.label === "current"));
    assert.ok(layers.some((l) => l.label === "optimal"));
    // Insights surface the lift + elasticity ranking
    assert.ok(toolOut.insights && toolOut.insights.length >= 2);
    assert.match(toolOut.insights![0].text, /Projected outcome lift: 8\.00%/);
    // operationResult is shape-correct for the W54 adapter
    assert.equal(isBudgetRedistributeOperationResult(toolOut.operationResult), true);

    // (4) W54 adapter — derives recommendations + magnitudes deterministically
    const op = toolOut.operationResult as { kind: "budget_redistribute"; payload: BudgetRedistributeResponse };
    const recs = buildRecommendationsFromBudgetOptimizer(op.payload);
    const mags = buildMagnitudesFromBudgetOptimizer(op.payload);
    const lens = buildDomainLensFromBudgetOptimizer(op.payload);

    // Headline + at least one Increase + at least one Decrease
    assert.ok(recs.length >= 3);
    assert.match(recs[0].action, /lift outcome by 8\.0%/);
    assert.ok(recs.some((r) => /Increase TV_Spend/.test(r.action)));
    assert.ok(recs.some((r) => /Decrease/.test(r.action)));
    // Magnitudes header
    assert.equal(mags[0].label, "Projected lift");
    assert.equal(mags[0].value, "8.0%");
    assert.match(mags[1].value, /2\.40M|2400000/);
    assert.match(lens, /adstock/);
    assert.match(lens, /SLSQP/);

    // Confidence high because R² >= 0.7 and no caveats
    assert.equal(mags[0].confidence, "high");
  });

  it("does not match a non-marketing question", () => {
    assert.equal(looksLikeBudgetReallocationQuestion("What is my top region by sales?"), false);
  });

  it("refuses cleanly when no row-level data is present", async () => {
    const reg = new ToolRegistry();
    registerBudgetOptimizerTool(reg);
    const ctx = { exec: { mode: "analysis", summary: syntheticMmmSummary(), data: [] }, config: {} } as any;
    const out = await reg.execute("run_budget_optimizer", {}, ctx);
    assert.equal(out.ok, false);
    assert.match(out.summary, /no row-level data/i);
  });
});
