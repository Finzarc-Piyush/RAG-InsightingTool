"""
Constrained budget optimizer over a fitted MMM response surface.

Variable: total spend per channel over the historical horizon.
Objective: maximize predicted total outcome (= minimize negative prediction).
Constraints:
  - equality: sum of per-channel totals = total_budget
  - bounds:   per-channel [min, max] (default 0.5× to 2.0× current spend)

Uses scipy.optimize SLSQP. We restart from three seeds and keep the best:
  (a) current allocation,
  (b) equal split across channels,
  (c) allocation proportional to point-estimate elasticities.
This guards against falling into flat regions when the response surface is
nearly linear in any single direction.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.optimize import minimize

from .fit import FitResult, predict_outcome_for_totals


@dataclass
class OptimizationResult:
    current_totals: dict[str, float]
    optimal_totals: dict[str, float]
    current_outcome: float
    optimal_outcome: float
    lift_pct: float
    converged: bool
    iterations: int
    bounds_used: dict[str, tuple[float, float]]
    total_budget_used: float


def _project(x: np.ndarray, bounds_seq: list[tuple[float, float]], total: float) -> np.ndarray:
    lb = np.array([b[0] for b in bounds_seq], dtype=float)
    ub = np.array([b[1] for b in bounds_seq], dtype=float)
    x_clip = np.clip(x.astype(float), lb, ub)
    s = float(np.sum(x_clip)) or 1e-12
    x_scaled = x_clip * (total / s)
    return np.clip(x_scaled, lb, ub)


def optimize_allocation(
    fit: FitResult,
    total_budget: Optional[float] = None,
    bounds: Optional[dict[str, tuple[float, float]]] = None,
    bound_multipliers: tuple[float, float] = (0.5, 2.0),
) -> OptimizationResult:
    if not fit.channels:
        raise ValueError("FitResult has no channels")
    channels = [c.name for c in fit.channels]
    cur = {c.name: float(c.current_total_spend) for c in fit.channels}
    cur_sum = float(sum(cur.values()))
    if total_budget is None:
        total_budget = cur_sum
    if total_budget <= 0:
        raise ValueError(f"total_budget must be > 0; got {total_budget}")
    if bounds is None:
        lo_m, hi_m = bound_multipliers
        bounds = {ch: (max(lo_m * cur[ch], 0.0), max(hi_m * cur[ch], 1e-6)) for ch in channels}

    bounds_seq = [bounds[ch] for ch in channels]
    lb_sum = float(sum(b[0] for b in bounds_seq))
    ub_sum = float(sum(b[1] for b in bounds_seq))
    if not (lb_sum - 1e-6 <= total_budget <= ub_sum + 1e-6):
        raise ValueError(
            f"total_budget {total_budget} infeasible: per-channel "
            f"bounds sum to [{lb_sum}, {ub_sum}]"
        )

    def neg_outcome(x_arr: np.ndarray) -> float:
        totals = {ch: float(x_arr[i]) for i, ch in enumerate(channels)}
        return -predict_outcome_for_totals(fit, totals)

    constraints = [{"type": "eq", "fun": lambda x: float(np.sum(x)) - total_budget}]

    # Seed (a) current allocation
    seeds = [np.array([cur[ch] for ch in channels], dtype=float)]
    # Seed (b) equal split
    seeds.append(np.full(len(channels), total_budget / len(channels), dtype=float))
    # Seed (c) elasticity-weighted
    elas = np.array([max(c.elasticity, 1e-6) for c in fit.channels], dtype=float)
    seeds.append(elas / elas.sum() * total_budget)

    best = None
    converged_any = False
    iters_total = 0
    for x0 in seeds:
        x0p = _project(x0, bounds_seq, total_budget)
        try:
            res = minimize(
                neg_outcome,
                x0p,
                method="SLSQP",
                bounds=bounds_seq,
                constraints=constraints,
                options={"ftol": 1e-6, "maxiter": 300},
            )
        except Exception:
            continue
        iters_total += int(res.nit)
        if res.success:
            converged_any = True
        if best is None or res.fun < best.fun:
            best = res
    if best is None:
        raise RuntimeError("SLSQP optimization failed at every starting seed")

    optimal_totals = {ch: float(best.x[i]) for i, ch in enumerate(channels)}
    optimal_outcome = -float(best.fun)
    current_outcome = float(predict_outcome_for_totals(fit, cur))
    denom = abs(current_outcome) or 1e-12
    lift_pct = (optimal_outcome - current_outcome) / denom * 100.0

    return OptimizationResult(
        current_totals=cur,
        optimal_totals=optimal_totals,
        current_outcome=current_outcome,
        optimal_outcome=optimal_outcome,
        lift_pct=float(lift_pct),
        converged=bool(converged_any),
        iterations=int(iters_total),
        bounds_used={ch: (float(b[0]), float(b[1])) for ch, b in bounds.items()},
        total_budget_used=float(total_budget),
    )
