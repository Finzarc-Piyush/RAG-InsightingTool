# Marketing-mix model & budget reallocation (W46–W55)

## Purpose

Answer the question "how should I redistribute my marketing budget?" end-to-
end. When a user uploads a marketing dataset (channel-spend × outcome × time)
and asks how to reallocate, the app fits a marketing-mix model (MMM), runs a
constrained optimizer over the fitted response surface, and returns a
deterministic recommendation set with current vs optimal allocations,
projected lift, response curves, and per-channel marginal-ROI rationales.

Inspired by Meta's Robyn (geometric adstock + Hill saturation + ridge), but
lighter: no Bayesian priors, no Nevergrad, no JAX. Pure numpy/pandas/sklearn
+ scipy SLSQP. Implementable in ~500 lines of Python and runs in seconds on
a synthetic 80-week × 3-channel dataset.

## Wave map

| Wave | Subject | Key file(s) |
|------|---------|-------------|
| W46  | Pure-fn marketing column tagger | [server/lib/marketingColumnTags.ts](../../server/lib/marketingColumnTags.ts) |
| W47  | Adstock + Hill saturation primitives | [python-service/mmm/transforms.py](../../python-service/mmm/transforms.py) |
| W48  | MMM fit (coordinate-descent grid + ridge + bootstrap CI) | [python-service/mmm/fit.py](../../python-service/mmm/fit.py) |
| W49  | scipy SLSQP optimizer | [python-service/mmm/optimize.py](../../python-service/mmm/optimize.py) |
| W50  | FastAPI route `/mmm/budget-redistribute` | [python-service/main.py](../../python-service/main.py) |
| W51  | Node bridge (`runBudgetRedistribute`) | [server/lib/dataOps/mmmService.ts](../../server/lib/dataOps/mmmService.ts) |
| W52  | `budget_reallocation` question shape + intent detector | [server/lib/agents/runtime/analysisBrief.ts](../../server/lib/agents/runtime/analysisBrief.ts) |
| W53  | Tool `run_budget_optimizer` | [server/lib/agents/runtime/tools/budgetOptimizerTool.ts](../../server/lib/agents/runtime/tools/budgetOptimizerTool.ts) |
| W54  | Output adapter (recommendations + magnitudes + domainLens) | [server/lib/agents/runtime/budgetOptimizerAdapter.ts](../../server/lib/agents/runtime/budgetOptimizerAdapter.ts) |
| W55  | Pipeline integration test + this doc | [server/tests/budgetOptimizerPipeline.test.ts](../../server/tests/budgetOptimizerPipeline.test.ts) |

## Modeling stack

```
spend_matrix  ──► geometric adstock (decay grid 0..0.8, stride 0.1)
                  │
                  ▼
              Hill saturation (k grid: 5 quantiles of non-zero spend, alpha ∈ {0.5, 1, 2, 3})
                  │
                  ▼
              ridge regression on transformed channels + linear trend + 11 month dummies
                  │
                  ├─► point estimate per channel: { decay, k, alpha, beta }
                  ├─► elasticity at observed mean: numeric ∂Y/∂X · X̄/Ȳ
                  └─► bootstrap 95% CI on elasticity (50 row resamples; adstock/Hill held fixed)
                  │
                  ▼
              scipy.optimize.minimize SLSQP
                  - objective: −predicted_total_outcome
                  - equality:  Σ totals = total_budget (default = current sum)
                  - bounds:    per-channel default 0.5×–2× current spend
                  - 3 starts:  current, equal split, elasticity-weighted
                  │
                  ▼
              { current_allocation, optimal_allocation, projected_lift_pct,
                response_curves (40-point sweep per channel),
                diagnostics: max_pairwise_VIF, model_caveats[] }
```

Hyperparameters (no Bayesian priors): `ridge_alpha=1.0`, `sweeps=2` (coordinate
descent), `bootstrap_iters=50`. All overridable via the request body.

## Request → response

`POST /mmm/budget-redistribute` (request body, snake_case):

```json
{
  "data": [{ "Week": "2024-01-01", "TV_Spend": 200, "Digital_Spend": 100, "Revenue": 10000 }, ...],
  "spend_columns": ["TV_Spend", "Digital_Spend"],
  "outcome_column": "Revenue",
  "time_column": "Week",
  "total_budget": 28000,                              // optional; default = sum(current)
  "per_channel_bounds": { "TV_Spend": [8000, 32000] }, // optional; overrides multipliers
  "bound_multipliers": [0.5, 2.0],                     // optional; default
  "bootstrap_iters": 50,                                // 0 to skip CIs
  "sweeps": 2, "ridge_alpha": 1.0, "seed": 42
}
```

Response (snake_case, mirrored on the Node side as `BudgetRedistributeResponse`):

```ts
{
  channels: [{ name, decay, k, alpha, beta, elasticity, elasticity_ci95, current_total_spend, optimal_total_spend, delta_pct }],
  current_allocation, optimal_allocation,                  // { channel: total }
  current_outcome, optimal_outcome, projected_lift_pct,
  converged, iterations, bounds_used, total_budget_used,
  fit_metrics: { r_squared, rmse, n_observations, max_pairwise_vif },
  model_caveats: ["low_confidence_short_history" | "confounded_elasticities_multicollinearity" | "weak_fit_low_r2"],
  response_curves: { [channel]: { x, y, current_x, optimal_x } }
}
```

## Caveats the system surfaces (does not hide)

- `low_confidence_short_history` — fewer than 26 weekly observations.
- `confounded_elasticities_multicollinearity` — max pairwise VIF > 5 between
  channels. Treat per-channel elasticities as confounded.
- `weak_fit_low_r2` — final R² < 0.3.
- **Within-sample bound**: optimizer caps each channel at 2× max observed
  spend by default. Extrapolation beyond observed ranges is unreliable.
- **Attribution-window assumption**: response within the data window only;
  not multi-touch attribution.

## Refusal path

The tool returns `ok: false` with a clear message when:
- Row-level data is empty (`ctx.exec.data.length === 0`).
- No spend columns can be tagged or named.
- No outcome column or time column is detected.
- A user-named column is missing from the dataset.
- The Python service returns an error (e.g. <12 weekly observations after
  cleaning).

The agentic loop renders the refusal message verbatim — no hallucinated
recommendations.

## How the planner picks this up

1. `analysisBrief.ts::looksLikeBudgetReallocationQuestion` recognises
   "redistribute", "reallocate", "media mix", "where should I spend", etc.
2. `shouldBuildAnalysisBrief` fires on this intent, so the brief LLM runs.
3. The brief prompt receives a deterministic marketing-column hint
   (`tagMarketingColumns`) when the dataset looks marketing-mix-shaped.
4. The brief LLM may set `questionShape: "budget_reallocation"`.
5. The planner sees `run_budget_optimizer` in the tool manifest and calls it.
6. The tool's response (`operationResult.kind === "budget_redistribute"`)
   triggers the W54 adapter, which deterministically replaces the LLM's
   recommendations with optimizer-derived per-channel actions.

## Verification

End-to-end smoke (manual):

```bash
# Terminal 1
cd python-service && python3 main.py
# Terminal 2
cd server && npm run dev
# Terminal 3
cd client && npm run dev
```

Upload `tests/fixtures/synthetic_mmm.csv` (or generate via
`python-service/tests/test_fit.py::_synth_dataset`). Ask "how should I
redistribute my marketing budget?" in chat. Expect:
- Allocation comparison bar (current vs optimal).
- Per-channel response curve charts with current + optimal reference lines.
- AnswerCard recommendations referencing each channel by name.

Automated:

```bash
cd server && npm test                                # full TS suite (incl. W46–W55)
cd python-service && python -m unittest discover -s tests   # 26 tests across W47–W49
```

## Non-goals (future waves)

- Bayesian MMM (PyMC-Marketing / LightweightMMM) behind a feature flag.
- Multi-touch attribution.
- Hierarchical MMM (geo × channel).
- Real-time platform integrations (Meta Ads / Google Ads).
- A user-facing what-if slider — return curves are read-only in v1.
