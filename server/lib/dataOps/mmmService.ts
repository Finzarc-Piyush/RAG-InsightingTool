/**
 * Node-side bridge to the Python /mmm/budget-redistribute endpoint.
 *
 * The Python service owns the modeling math (adstock + Hill saturation +
 * ridge + SLSQP). This module only handles the typed request/response
 * contract and reuses pythonServiceFetch for auth + timeout.
 */
import { pythonServiceFetch } from "./pythonService.js";

export interface ChannelFitOut {
  name: string;
  decay: number;
  k: number;
  alpha: number;
  beta: number;
  elasticity: number;
  elasticity_ci95: [number, number];
  current_total_spend: number;
  optimal_total_spend: number;
  delta_pct: number;
}

export interface ResponseCurve {
  x: number[];
  y: number[];
  current_x: number;
  optimal_x: number;
}

export interface FitMetrics {
  r_squared: number;
  rmse: number;
  n_observations: number;
  max_pairwise_vif: number;
}

export interface BudgetRedistributeResponse {
  channels: ChannelFitOut[];
  current_allocation: Record<string, number>;
  optimal_allocation: Record<string, number>;
  current_outcome: number;
  optimal_outcome: number;
  projected_lift_pct: number;
  converged: boolean;
  iterations: number;
  bounds_used: Record<string, [number, number]>;
  total_budget_used: number;
  fit_metrics: FitMetrics;
  model_caveats: string[];
  response_curves: Record<string, ResponseCurve>;
}

export interface BudgetRedistributeRequest {
  data: Record<string, unknown>[];
  spendColumns: string[];
  outcomeColumn: string;
  timeColumn: string;
  totalBudget?: number;
  perChannelBounds?: Record<string, [number, number]>;
  boundMultipliers?: [number, number];
  bootstrapIters?: number;
  seed?: number;
  ridgeAlpha?: number;
  sweeps?: number;
  maxObs?: number;
}

const MMM_REQUEST_TIMEOUT_MS = 240_000; // 4 min — Python gate is 180s + headroom

export type MmmFetcher = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number
) => Promise<Response>;

export async function runBudgetRedistribute(
  req: BudgetRedistributeRequest,
  fetcher: MmmFetcher = pythonServiceFetch
): Promise<BudgetRedistributeResponse> {
  if (!Array.isArray(req.data) || req.data.length === 0) {
    throw new Error("runBudgetRedistribute: data must be a non-empty array");
  }
  if (!req.spendColumns?.length) {
    throw new Error("runBudgetRedistribute: spendColumns must be non-empty");
  }
  if (!req.outcomeColumn || !req.timeColumn) {
    throw new Error("runBudgetRedistribute: outcomeColumn and timeColumn are required");
  }

  const body = {
    data: req.data,
    spend_columns: req.spendColumns,
    outcome_column: req.outcomeColumn,
    time_column: req.timeColumn,
    total_budget: req.totalBudget,
    per_channel_bounds: req.perChannelBounds,
    bound_multipliers: req.boundMultipliers,
    bootstrap_iters: req.bootstrapIters ?? 50,
    seed: req.seed ?? 42,
    ridge_alpha: req.ridgeAlpha ?? 1.0,
    sweeps: req.sweeps ?? 2,
    max_obs: req.maxObs,
  };

  const resp = await fetcher(
    "/mmm/budget-redistribute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    MMM_REQUEST_TIMEOUT_MS
  );

  if (!resp.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await resp.json());
    } catch {
      detail = `${resp.status} ${resp.statusText}`;
    }
    throw new Error(`/mmm/budget-redistribute failed: ${detail}`);
  }

  return (await resp.json()) as BudgetRedistributeResponse;
}
