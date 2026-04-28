import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBudgetRedistributeOperationResult,
  buildRecommendationsFromBudgetOptimizer,
  buildMagnitudesFromBudgetOptimizer,
  buildDomainLensFromBudgetOptimizer,
} from "../lib/agents/runtime/budgetOptimizerAdapter.js";
import type { BudgetRedistributeResponse } from "../lib/dataOps/mmmService.js";

function makePayload(overrides: Partial<BudgetRedistributeResponse> = {}): BudgetRedistributeResponse {
  return {
    channels: [
      {
        name: "TV",
        decay: 0.5, k: 200, alpha: 1.5, beta: 80,
        elasticity: 0.42, elasticity_ci95: [0.32, 0.52],
        current_total_spend: 16000, optimal_total_spend: 19200, delta_pct: 20,
      },
      {
        name: "Digital",
        decay: 0.2, k: 100, alpha: 1.0, beta: 60,
        elasticity: 0.18, elasticity_ci95: [0.1, 0.26],
        current_total_spend: 8000, optimal_total_spend: 6400, delta_pct: -20,
      },
      {
        name: "OOH",
        decay: 0.1, k: 80, alpha: 2.0, beta: 40,
        elasticity: 0.05, elasticity_ci95: [0.0, 0.1],
        current_total_spend: 4000, optimal_total_spend: 2400, delta_pct: -40,
      },
    ],
    current_allocation: { TV: 16000, Digital: 8000, OOH: 4000 },
    optimal_allocation: { TV: 19200, Digital: 6400, OOH: 2400 },
    current_outcome: 1000, optimal_outcome: 1080, projected_lift_pct: 8.0,
    converged: true, iterations: 25,
    bounds_used: { TV: [8000, 32000], Digital: [4000, 16000], OOH: [2000, 8000] },
    total_budget_used: 28000,
    fit_metrics: { r_squared: 0.78, rmse: 12, n_observations: 80, max_pairwise_vif: 2.1 },
    model_caveats: [],
    response_curves: {
      TV: { x: [0, 16000, 32000], y: [0, 60, 90], current_x: 16000, optimal_x: 19200 },
      Digital: { x: [0, 8000, 16000], y: [0, 30, 42], current_x: 8000, optimal_x: 6400 },
      OOH: { x: [0, 4000, 8000], y: [0, 16, 20], current_x: 4000, optimal_x: 2400 },
    },
    ...overrides,
  };
}

describe("isBudgetRedistributeOperationResult", () => {
  it("matches the budget_redistribute kind only", () => {
    assert.equal(isBudgetRedistributeOperationResult({ kind: "budget_redistribute", payload: {} }), true);
    assert.equal(isBudgetRedistributeOperationResult({ kind: "other", payload: {} }), false);
    assert.equal(isBudgetRedistributeOperationResult(null), false);
    assert.equal(isBudgetRedistributeOperationResult(undefined), false);
    assert.equal(isBudgetRedistributeOperationResult({ kind: "budget_redistribute" }), false);
  });
});

describe("buildRecommendationsFromBudgetOptimizer", () => {
  it("leads with a headline action containing the projected lift", () => {
    const recs = buildRecommendationsFromBudgetOptimizer(makePayload());
    assert.ok(recs.length >= 1);
    assert.match(recs[0].action, /lift outcome by 8\.0%/);
    assert.equal(recs[0].horizon, "now");
  });

  it("includes per-channel actions ranked by absolute delta", () => {
    const recs = buildRecommendationsFromBudgetOptimizer(makePayload());
    assert.ok(recs.length >= 2);
    // Largest absolute delta is TV (3200)
    assert.match(recs[1].action, /Increase TV/);
    assert.match(recs[1].action, /\+20\.0%/);
  });

  it("uses 'Decrease' phrasing for negative deltas", () => {
    const recs = buildRecommendationsFromBudgetOptimizer(makePayload());
    const decreaseRec = recs.find((r) => /Decrease/.test(r.action));
    assert.ok(decreaseRec, "expected at least one Decrease recommendation");
    assert.match(decreaseRec!.rationale, /Diminishing returns/);
  });

  it("caps total recommendations at 4", () => {
    const channels = Array.from({ length: 8 }, (_, i) => ({
      name: `C${i}`,
      decay: 0.3, k: 100, alpha: 1, beta: 50,
      elasticity: 0.1, elasticity_ci95: [0, 0.2] as [number, number],
      current_total_spend: 1000,
      optimal_total_spend: 1000 + (i + 1) * 200,
      delta_pct: ((i + 1) * 200) / 1000 * 100,
    }));
    const payload = makePayload({ channels, total_budget_used: 8000 });
    const recs = buildRecommendationsFromBudgetOptimizer(payload);
    assert.ok(recs.length <= 4);
  });

  it("skips the headline when projected lift is negligible", () => {
    const payload = makePayload({ projected_lift_pct: 0.1 });
    const recs = buildRecommendationsFromBudgetOptimizer(payload);
    assert.ok(!recs[0].action.includes("lift outcome"));
  });
});

describe("buildMagnitudesFromBudgetOptimizer", () => {
  it("emits projected lift, total budget, and biggest shift", () => {
    const mags = buildMagnitudesFromBudgetOptimizer(makePayload());
    assert.equal(mags[0].label, "Projected lift");
    assert.equal(mags[0].value, "8.0%");
    assert.equal(mags[1].label, "Total budget held");
    assert.match(mags[1].value, /28\.0k|28000/);
    assert.match(mags[2].label, /Biggest shift/);
  });

  it("downgrades confidence when low_confidence_short_history is set", () => {
    const mags = buildMagnitudesFromBudgetOptimizer(
      makePayload({ model_caveats: ["low_confidence_short_history"] })
    );
    assert.equal(mags[0].confidence, "low");
  });
});

describe("buildDomainLensFromBudgetOptimizer", () => {
  it("describes methodology and surface caveats", () => {
    const lens = buildDomainLensFromBudgetOptimizer(
      makePayload({ model_caveats: ["confounded_elasticities_multicollinearity"] })
    );
    assert.match(lens, /adstock/);
    assert.match(lens, /Hill saturation/);
    assert.match(lens, /confounded/);
  });
});
