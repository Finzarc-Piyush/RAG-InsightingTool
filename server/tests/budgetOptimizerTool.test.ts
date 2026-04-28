import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerBudgetOptimizerTool } from "../lib/agents/runtime/tools/budgetOptimizerTool.js";
import type { BudgetRedistributeResponse, MmmFetcher } from "../lib/dataOps/mmmService.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(): DataSummary {
  return {
    rowCount: 80,
    columnCount: 5,
    columns: [
      { name: "Week", type: "date", sampleValues: ["2024-01-01"] },
      { name: "TV_Spend", type: "number", sampleValues: [200] },
      { name: "Digital_Spend", type: "number", sampleValues: [100] },
      { name: "OOH_Spend", type: "number", sampleValues: [50] },
      { name: "Revenue", type: "number", sampleValues: [10000] },
    ],
    numericColumns: ["TV_Spend", "Digital_Spend", "OOH_Spend", "Revenue"],
    dateColumns: ["Week"],
  };
}

function makeFakeResponse(): BudgetRedistributeResponse {
  return {
    channels: [
      {
        name: "TV_Spend",
        decay: 0.5,
        k: 200,
        alpha: 1.5,
        beta: 80,
        elasticity: 0.42,
        elasticity_ci95: [0.32, 0.52],
        current_total_spend: 16000,
        optimal_total_spend: 19200,
        delta_pct: 20,
      },
      {
        name: "Digital_Spend",
        decay: 0.2,
        k: 100,
        alpha: 1.0,
        beta: 60,
        elasticity: 0.18,
        elasticity_ci95: [0.1, 0.26],
        current_total_spend: 8000,
        optimal_total_spend: 6400,
        delta_pct: -20,
      },
      {
        name: "OOH_Spend",
        decay: 0.1,
        k: 80,
        alpha: 2.0,
        beta: 40,
        elasticity: 0.05,
        elasticity_ci95: [0.0, 0.1],
        current_total_spend: 4000,
        optimal_total_spend: 2400,
        delta_pct: -40,
      },
    ],
    current_allocation: { TV_Spend: 16000, Digital_Spend: 8000, OOH_Spend: 4000 },
    optimal_allocation: { TV_Spend: 19200, Digital_Spend: 6400, OOH_Spend: 2400 },
    current_outcome: 1000,
    optimal_outcome: 1080,
    projected_lift_pct: 8.0,
    converged: true,
    iterations: 25,
    bounds_used: { TV_Spend: [8000, 32000], Digital_Spend: [4000, 16000], OOH_Spend: [2000, 8000] },
    total_budget_used: 28000,
    fit_metrics: { r_squared: 0.78, rmse: 12, n_observations: 80, max_pairwise_vif: 2.1 },
    model_caveats: [],
    response_curves: {
      TV_Spend: { x: [0, 8000, 16000, 24000, 32000], y: [0, 30, 60, 80, 90], current_x: 16000, optimal_x: 19200 },
      Digital_Spend: { x: [0, 4000, 8000, 12000, 16000], y: [0, 18, 30, 38, 42], current_x: 8000, optimal_x: 6400 },
      OOH_Spend: { x: [0, 2000, 4000, 6000, 8000], y: [0, 10, 16, 19, 20], current_x: 4000, optimal_x: 2400 },
    },
  };
}

function makeCtx(summary: DataSummary, data: Record<string, any>[]): any {
  return {
    exec: {
      mode: "analysis",
      summary,
      data,
    },
    config: {},
  };
}

describe("registerBudgetOptimizerTool", () => {
  it("registers under the name run_budget_optimizer", () => {
    const reg = new ToolRegistry();
    registerBudgetOptimizerTool(reg);
    assert.ok(reg.listToolDescriptions().includes("run_budget_optimizer"));
  });

  it("returns ok=false when no row-level data is present", async () => {
    const reg = new ToolRegistry();
    registerBudgetOptimizerTool(reg);
    const ctx = makeCtx(makeSummary(), []);
    const out = await reg.execute("run_budget_optimizer", {}, ctx);
    assert.equal(out.ok, false);
    assert.match(out.summary, /no row-level data/i);
  });

  it("returns ok=false when no spend columns can be tagged", async () => {
    const reg = new ToolRegistry();
    registerBudgetOptimizerTool(reg);
    const summary: DataSummary = {
      rowCount: 50,
      columnCount: 2,
      columns: [
        { name: "Week", type: "date", sampleValues: ["2024-01-01"] },
        { name: "Revenue", type: "number", sampleValues: [10000] },
      ],
      numericColumns: ["Revenue"],
      dateColumns: ["Week"],
    };
    const ctx = makeCtx(summary, [{ Week: "2024-01-01", Revenue: 100 }]);
    const out = await reg.execute("run_budget_optimizer", {}, ctx);
    assert.equal(out.ok, false);
    assert.match(out.summary, /spend/i);
  });

  it("auto-fills missing args from the marketing tagger and emits charts + insights", async () => {
    const reg = new ToolRegistry();
    const fetcher: MmmFetcher = async (_path, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.deepEqual(body.spend_columns.sort(), ["Digital_Spend", "OOH_Spend", "TV_Spend"]);
      assert.equal(body.outcome_column, "Revenue");
      assert.equal(body.time_column, "Week");
      return new Response(JSON.stringify(makeFakeResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    registerBudgetOptimizerTool(reg, { fetcher });
    const ctx = makeCtx(makeSummary(), [
      { Week: "2024-01-01", TV_Spend: 200, Digital_Spend: 100, OOH_Spend: 50, Revenue: 10000 },
    ]);
    const out = await reg.execute("run_budget_optimizer", {}, ctx);
    assert.equal(out.ok, true);
    assert.ok(out.charts && out.charts.length === 4); // allocation + 3 response curves
    assert.equal(out.charts![0].type, "bar");
    assert.equal(out.charts![0].seriesColumn, "scenario");
    assert.ok(out.charts![1].title.startsWith("Response curve"));
    assert.ok(out.insights && out.insights.length >= 3);
    assert.match(out.summary, /Projected lift: 8\.00%/);
    assert.equal((out.operationResult as any).kind, "budget_redistribute");
    assert.equal((out.operationResult as any).payload.projected_lift_pct, 8);
    assert.ok(out.memorySlots?.budget_optimizer_lift_pct);
  });

  it("propagates python-service errors as ok=false", async () => {
    const reg = new ToolRegistry();
    const fetcher: MmmFetcher = async () =>
      new Response(JSON.stringify({ detail: "Need at least 12 weekly observations" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    registerBudgetOptimizerTool(reg, { fetcher });
    const ctx = makeCtx(makeSummary(), [
      { Week: "2024-01-01", TV_Spend: 200, Digital_Spend: 100, OOH_Spend: 50, Revenue: 10000 },
    ]);
    const out = await reg.execute("run_budget_optimizer", {}, ctx);
    assert.equal(out.ok, false);
    assert.match(out.summary, /Need at least 12 weekly observations/);
  });

  it("rejects when an explicit spendColumn is not in the schema", async () => {
    const reg = new ToolRegistry();
    registerBudgetOptimizerTool(reg);
    const ctx = makeCtx(makeSummary(), [{ Week: "2024-01-01", TV_Spend: 200, Revenue: 10000 }]);
    const out = await reg.execute(
      "run_budget_optimizer",
      { spendColumns: ["TV_Spend", "BogusColumn"], outcomeColumn: "Revenue", timeColumn: "Week" },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /BogusColumn/);
  });
});
