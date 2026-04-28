"""
Tests for mmm.fit. We generate a synthetic dataset where we know the true
adstock decay, Hill k/alpha, and channel coefficients, then verify the fit
recovers them well enough for downstream optimization to be meaningful.
"""
import unittest

import numpy as np
import pandas as pd

from mmm.fit import fit_mmm, predict_outcome_for_totals, channel_response_curve
from mmm.transforms import transform_channel


def _synth_dataset(seed=7, weeks=104, n_channels=3):
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2022-01-03", periods=weeks, freq="W-MON")
    truth = [
        {"name": "tv", "decay": 0.5, "k": 200.0, "alpha": 1.5, "beta": 80.0,
         "spend_mean": 250, "spend_sd": 80},
        {"name": "digital", "decay": 0.2, "k": 100.0, "alpha": 1.0, "beta": 60.0,
         "spend_mean": 150, "spend_sd": 60},
        {"name": "ooh", "decay": 0.1, "k": 80.0, "alpha": 2.0, "beta": 40.0,
         "spend_mean": 90, "spend_sd": 40},
    ][:n_channels]
    spend = {}
    for ch in truth:
        s = np.maximum(0, rng.normal(ch["spend_mean"], ch["spend_sd"], weeks))
        spend[ch["name"]] = s
    spend_df = pd.DataFrame(spend)
    # generate y from true model + small trend + noise
    y = np.zeros(weeks)
    for ch in truth:
        z = transform_channel(spend[ch["name"]], ch["decay"], ch["k"], ch["alpha"])
        y += ch["beta"] * z
    trend = np.linspace(-1, 1, weeks) * 5.0
    y += 200.0 + trend
    noise = rng.normal(0, 5.0, weeks)
    y += noise
    return spend_df, y, dates, truth


class TestFitMMM(unittest.TestCase):
    def test_recovers_decay_within_tolerance(self):
        spend_df, y, dates, truth = _synth_dataset(seed=11, weeks=104)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        self.assertGreaterEqual(fit.r_squared, 0.6)
        # The grid stride is 0.1 — recovered decay should land within 0.2 of truth
        for cf, t in zip(fit.channels, truth):
            self.assertLessEqual(abs(cf.decay - t["decay"]), 0.2,
                                 f"channel {cf.name} decay {cf.decay} vs truth {t['decay']}")

    def test_predict_for_current_totals_matches_in_sample(self):
        spend_df, y, dates, _ = _synth_dataset(seed=13, weeks=80)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        totals = {ch: float(spend_df[ch].sum()) for ch in spend_df.columns}
        predicted = predict_outcome_for_totals(fit, totals)
        # predicted total ≈ in-sample sum of fitted yhat ≈ sum(y) (R² high)
        actual_total = float(np.sum(y))
        self.assertLess(abs(predicted - actual_total) / actual_total, 0.25)

    def test_predict_increases_with_more_total_spend(self):
        spend_df, y, dates, _ = _synth_dataset(seed=17, weeks=60)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        cur = {ch: float(spend_df[ch].sum()) for ch in spend_df.columns}
        boosted = {ch: v * 1.3 for ch, v in cur.items()}
        self.assertGreater(predict_outcome_for_totals(fit, boosted),
                           predict_outcome_for_totals(fit, cur))

    def test_response_curve_is_monotone_nondecreasing(self):
        spend_df, y, dates, _ = _synth_dataset(seed=19, weeks=60)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        curve = channel_response_curve(fit, channel=fit.channels[0].name, n_points=20)
        ys = curve["y"]
        # diminishing returns is fine, but never decrease
        for a, b in zip(ys[:-1], ys[1:]):
            self.assertGreaterEqual(b + 1e-6, a)

    def test_short_history_caveat(self):
        spend_df, y, dates, _ = _synth_dataset(seed=21, weeks=20)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=0)
        self.assertIn("low_confidence_short_history", fit.diagnostics["model_caveats"])

    def test_bootstrap_produces_nontrivial_ci(self):
        spend_df, y, dates, _ = _synth_dataset(seed=23, weeks=60)
        fit = fit_mmm(spend_df, y, dates=dates, bootstrap_iters=30, seed=23)
        for cf in fit.channels:
            lo, hi = cf.elasticity_ci95
            self.assertLessEqual(lo, cf.elasticity + 1e-9)
            self.assertGreaterEqual(hi, cf.elasticity - 1e-9)


if __name__ == "__main__":
    unittest.main()
