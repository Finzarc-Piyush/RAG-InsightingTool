"""
Tests for mmm.optimize. We construct a FitResult from a synthetic dataset
where one channel has a clearly higher elasticity than another and assert
the optimizer reallocates toward it within bounds.
"""
import unittest

import numpy as np
import pandas as pd

from mmm.fit import fit_mmm, predict_outcome_for_totals
from mmm.optimize import optimize_allocation
from mmm.transforms import transform_channel


def _two_channel_synth(seed=29, weeks=80):
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2022-01-03", periods=weeks, freq="W-MON")
    # high-elasticity channel A vs low-elasticity channel B
    spend_a = np.maximum(0, rng.normal(200, 60, weeks))
    spend_b = np.maximum(0, rng.normal(200, 60, weeks))
    z_a = transform_channel(spend_a, decay=0.4, k=180.0, alpha=1.5)
    z_b = transform_channel(spend_b, decay=0.2, k=180.0, alpha=1.5)
    y = 100.0 + 120.0 * z_a + 30.0 * z_b + rng.normal(0, 3.0, weeks)
    return pd.DataFrame({"a": spend_a, "b": spend_b}), y, dates


class TestOptimizeAllocation(unittest.TestCase):
    def test_reallocates_toward_higher_elasticity_channel(self):
        spend_df, y, dates = _two_channel_synth()
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        opt = optimize_allocation(fit)
        self.assertTrue(opt.converged)
        # 'a' has 4x the coefficient — under equal current spend, optimal must shift to 'a'
        self.assertGreater(opt.optimal_totals["a"], opt.current_totals["a"])
        self.assertLess(opt.optimal_totals["b"], opt.current_totals["b"])

    def test_total_budget_preserved(self):
        spend_df, y, dates = _two_channel_synth(seed=31)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        opt = optimize_allocation(fit)
        original_total = sum(opt.current_totals.values())
        new_total = sum(opt.optimal_totals.values())
        self.assertAlmostEqual(new_total, original_total, places=2)

    def test_respects_per_channel_bounds(self):
        spend_df, y, dates = _two_channel_synth(seed=33)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        cur_a = float(spend_df["a"].sum())
        cur_b = float(spend_df["b"].sum())
        bounds = {"a": (cur_a * 0.9, cur_a * 1.1), "b": (cur_b * 0.9, cur_b * 1.1)}
        opt = optimize_allocation(fit, bounds=bounds)
        self.assertGreaterEqual(opt.optimal_totals["a"], bounds["a"][0] - 1e-3)
        self.assertLessEqual(opt.optimal_totals["a"], bounds["a"][1] + 1e-3)
        self.assertGreaterEqual(opt.optimal_totals["b"], bounds["b"][0] - 1e-3)
        self.assertLessEqual(opt.optimal_totals["b"], bounds["b"][1] + 1e-3)

    def test_lift_is_non_negative(self):
        spend_df, y, dates = _two_channel_synth(seed=37)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        opt = optimize_allocation(fit)
        # Optimum can never be worse than current allocation under same constraints.
        self.assertGreaterEqual(opt.lift_pct, -0.5)  # tiny tolerance for numerical noise

    def test_total_budget_override(self):
        spend_df, y, dates = _two_channel_synth(seed=41)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        cur_total = float(spend_df.values.sum())
        opt = optimize_allocation(fit, total_budget=cur_total * 1.5)
        new_total = sum(opt.optimal_totals.values())
        self.assertAlmostEqual(new_total, cur_total * 1.5, places=1)

    def test_infeasible_total_budget_raises(self):
        spend_df, y, dates = _two_channel_synth(seed=43)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        with self.assertRaises(ValueError):
            # total way above 2× sum of all bounds
            optimize_allocation(fit, total_budget=float(spend_df.values.sum()) * 100.0)


if __name__ == "__main__":
    unittest.main()
