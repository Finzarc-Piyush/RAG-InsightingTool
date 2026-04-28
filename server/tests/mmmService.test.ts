import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runBudgetRedistribute,
  type BudgetRedistributeResponse,
  type MmmFetcher,
} from "../lib/dataOps/mmmService.js";

function makeFetcher(response: { status: number; body: unknown }): {
  fetcher: MmmFetcher;
  calls: Array<{ path: string; init?: RequestInit; timeoutMs?: number }>;
} {
  const calls: Array<{ path: string; init?: RequestInit; timeoutMs?: number }> = [];
  const fetcher: MmmFetcher = async (path, init, timeoutMs) => {
    calls.push({ path, init, timeoutMs });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const sampleResponse: BudgetRedistributeResponse = {
  channels: [
    {
      name: "tv",
      decay: 0.5,
      k: 200,
      alpha: 1.5,
      beta: 80,
      elasticity: 0.4,
      elasticity_ci95: [0.3, 0.5],
      current_total_spend: 10000,
      optimal_total_spend: 12000,
      delta_pct: 20,
    },
  ],
  current_allocation: { tv: 10000 },
  optimal_allocation: { tv: 12000 },
  current_outcome: 1000,
  optimal_outcome: 1100,
  projected_lift_pct: 10,
  converged: true,
  iterations: 12,
  bounds_used: { tv: [5000, 20000] },
  total_budget_used: 12000,
  fit_metrics: { r_squared: 0.85, rmse: 5, n_observations: 80, max_pairwise_vif: 1.5 },
  model_caveats: [],
  response_curves: { tv: { x: [0, 5000, 10000], y: [0, 50, 100], current_x: 10000, optimal_x: 12000 } },
};

describe("runBudgetRedistribute", () => {
  it("posts to /mmm/budget-redistribute with snake_cased body", async () => {
    const { fetcher, calls } = makeFetcher({ status: 200, body: sampleResponse });
    const out = await runBudgetRedistribute(
      {
        data: [{ week: "2024-01-01", tv: 100, revenue: 200 }],
        spendColumns: ["tv"],
        outcomeColumn: "revenue",
        timeColumn: "week",
        bootstrapIters: 25,
        ridgeAlpha: 0.5,
      },
      fetcher
    );
    assert.equal(out.projected_lift_pct, 10);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/mmm/budget-redistribute");
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.equal(sent.spend_columns[0], "tv");
    assert.equal(sent.outcome_column, "revenue");
    assert.equal(sent.time_column, "week");
    assert.equal(sent.bootstrap_iters, 25);
    assert.equal(sent.ridge_alpha, 0.5);
    assert.equal(sent.seed, 42);
    assert.equal(sent.sweeps, 2);
  });

  it("throws when the python service returns a non-200", async () => {
    const { fetcher } = makeFetcher({
      status: 400,
      body: { detail: "Need at least 12 weekly observations" },
    });
    await assert.rejects(
      runBudgetRedistribute(
        {
          data: [{ week: "2024-01-01", tv: 100, revenue: 200 }],
          spendColumns: ["tv"],
          outcomeColumn: "revenue",
          timeColumn: "week",
        },
        fetcher
      ),
      /Need at least 12 weekly observations/
    );
  });

  it("rejects empty data fast (no fetch call)", async () => {
    const { fetcher, calls } = makeFetcher({ status: 200, body: sampleResponse });
    await assert.rejects(
      runBudgetRedistribute(
        {
          data: [],
          spendColumns: ["tv"],
          outcomeColumn: "revenue",
          timeColumn: "week",
        },
        fetcher
      ),
      /non-empty array/
    );
    assert.equal(calls.length, 0);
  });

  it("rejects missing spendColumns", async () => {
    const { fetcher } = makeFetcher({ status: 200, body: sampleResponse });
    await assert.rejects(
      runBudgetRedistribute(
        {
          data: [{ week: "2024-01-01", tv: 100, revenue: 200 }],
          spendColumns: [],
          outcomeColumn: "revenue",
          timeColumn: "week",
        },
        fetcher
      ),
      /spendColumns must be non-empty/
    );
  });
});
