"""
Marketing-mix model fit.

Pipeline:
  1. Per-channel coordinate-descent grid search over (decay, k, alpha) using
     adstock + Hill saturation primitives from `transforms.py`.
  2. Ridge regression on (transformed channels + linear trend + month dummies).
  3. Per-channel point elasticity computed numerically at observed mean spend.
  4. Bootstrap 95% CI on elasticities by resampling rows of the design matrix
     (adstock/Hill params held at point estimates — keeps it fast).
  5. Diagnostics: pairwise multicollinearity proxy, sample-size flags.

The fit object exposes `predict_outcome_for_totals`, used by the W49 optimizer
to score candidate budget allocations.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from .transforms import (
    transform_channel,
    adstock_grid,
    hill_k_grid,
    hill_alpha_grid,
)


@dataclass
class ChannelFit:
    name: str
    decay: float
    k: float
    alpha: float
    beta: float
    elasticity: float
    elasticity_ci95: tuple[float, float]
    current_total_spend: float


@dataclass
class FitResult:
    channels: list[ChannelFit]
    intercept: float
    trend_coef: float
    month_coefs: list[float]
    r_squared: float
    rmse: float
    n_observations: int
    diagnostics: dict
    # Internal — needed for predict
    _channel_names: list[str] = field(default_factory=list)
    _has_seasonality: bool = False
    _spend_template: Optional[pd.DataFrame] = None
    _dates_template: Optional[np.ndarray] = None


def _build_design_matrix(
    spend: pd.DataFrame,
    channel_params: dict[str, dict],
    dates: Optional[np.ndarray],
) -> tuple[np.ndarray, list[str]]:
    cols: list[np.ndarray] = []
    names: list[str] = []
    for ch in spend.columns:
        p = channel_params[ch]
        z = transform_channel(spend[ch].values.astype(float), p["decay"], p["k"], p["alpha"])
        cols.append(z)
        names.append(f"x_{ch}")
    T = len(spend)
    # Linear trend, centered+scaled to ~[-1, 1]
    half = max((T - 1) / 2.0, 1.0)
    t = (np.arange(T, dtype=float) - (T - 1) / 2.0) / half
    cols.append(t)
    names.append("trend")
    if dates is not None:
        months = pd.to_datetime(np.asarray(dates)).month
        for m in range(1, 12):  # drop December reference category
            cols.append((months == m).astype(float))
            names.append(f"m_{m}")
    return np.column_stack(cols), names


def _fit_ridge(X: np.ndarray, y: np.ndarray, ridge_alpha: float) -> tuple[Ridge, float, float, np.ndarray]:
    model = Ridge(alpha=ridge_alpha, fit_intercept=True)
    model.fit(X, y)
    yhat = model.predict(X)
    ss_res = float(np.sum((y - yhat) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2)) or 1e-12
    r2 = 1.0 - ss_res / ss_tot
    rmse = float(np.sqrt(ss_res / len(y)))
    return model, r2, rmse, yhat


def _grid_search_one_channel(
    target: str,
    spend_df: pd.DataFrame,
    y: np.ndarray,
    params: dict[str, dict],
    dates: Optional[np.ndarray],
    ridge_alpha: float,
) -> dict:
    decays = adstock_grid()
    ks = hill_k_grid(spend_df[target].values, n=5)
    alphas = hill_alpha_grid()
    best = None
    for d in decays:
        for k in ks:
            for a in alphas:
                trial = dict(params)
                trial[target] = {"decay": d, "k": k, "alpha": a}
                X, _ = _build_design_matrix(spend_df, trial, dates)
                _, r2, rmse, _ = _fit_ridge(X, y, ridge_alpha)
                if best is None or rmse < best["rmse"]:
                    best = {"decay": d, "k": k, "alpha": a, "rmse": rmse, "r2": r2}
    return best  # type: ignore[return-value]


def _max_pairwise_vif(spend_df: pd.DataFrame) -> float:
    arr = spend_df.values
    if arr.shape[1] < 2:
        return 1.0
    corr = np.corrcoef(arr.T)
    n = arr.shape[1]
    max_v = 1.0
    for i in range(n):
        for j in range(i + 1, n):
            r = corr[i, j]
            if not np.isfinite(r):
                continue
            r2 = r * r
            v = 1.0 / max(1.0 - r2, 1e-9)
            if v > max_v:
                max_v = v
    return float(max_v)


def fit_mmm(
    spend_df: pd.DataFrame,
    y: np.ndarray,
    dates: Optional[Sequence] = None,
    ridge_alpha: float = 1.0,
    sweeps: int = 2,
    bootstrap_iters: int = 50,
    seed: int = 42,
    max_obs: Optional[int] = None,
) -> FitResult:
    if max_obs is not None and len(spend_df) > max_obs:
        spend_df = spend_df.iloc[-max_obs:].reset_index(drop=True)
        y = np.asarray(y)[-max_obs:]
        if dates is not None:
            dates = np.asarray(dates)[-max_obs:]

    spend_df = spend_df.copy().reset_index(drop=True)
    y = np.asarray(y, dtype=float).reshape(-1)
    if dates is not None:
        dates = np.asarray(dates)
    n_obs = len(spend_df)
    channels = list(spend_df.columns)
    if n_obs != len(y):
        raise ValueError(f"spend_df rows ({n_obs}) != y length ({len(y)})")
    if not channels:
        raise ValueError("spend_df must have at least one channel column")

    # init: decay=0.3, k=median non-zero spend, alpha=1
    params: dict[str, dict] = {}
    for ch in channels:
        nz = spend_df[ch].replace(0, np.nan).dropna().values
        med = float(np.median(nz)) if nz.size else 1.0
        params[ch] = {"decay": 0.3, "k": max(med, 1e-6), "alpha": 1.0}

    # coordinate descent
    for _ in range(sweeps):
        for ch in channels:
            best = _grid_search_one_channel(ch, spend_df, y, params, dates, ridge_alpha)
            params[ch] = {"decay": best["decay"], "k": best["k"], "alpha": best["alpha"]}

    # final fit
    X, _ = _build_design_matrix(spend_df, params, dates)
    model, r2, rmse, _ = _fit_ridge(X, y, ridge_alpha)
    coefs = model.coef_
    intercept = float(model.intercept_)

    y_total = float(np.sum(y)) or 1e-12

    # bootstrap betas (cheap — adstock/Hill params held fixed)
    boot_betas: dict[str, list[float]] = {ch: [] for ch in channels}
    if bootstrap_iters > 0:
        rng = np.random.default_rng(seed)
        for _ in range(bootstrap_iters):
            idx = rng.integers(0, n_obs, size=n_obs)
            m_b, _, _, _ = _fit_ridge(X[idx], y[idx], ridge_alpha)
            for i, ch in enumerate(channels):
                boot_betas[ch].append(float(m_b.coef_[i]))

    channel_fits: list[ChannelFit] = []
    for i, ch in enumerate(channels):
        beta = float(coefs[i])
        cur_total = float(spend_df[ch].sum())
        z_base = transform_channel(
            spend_df[ch].values.astype(float),
            params[ch]["decay"], params[ch]["k"], params[ch]["alpha"],
        )
        z_pert = transform_channel(
            spend_df[ch].values.astype(float) * 1.01,
            params[ch]["decay"], params[ch]["k"], params[ch]["alpha"],
        )
        d_z_total = float(z_pert.sum() - z_base.sum())
        d_x_total = float(cur_total * 0.01) or 1e-12

        def el_from_beta(b: float) -> float:
            d_y_total = b * d_z_total
            return (d_y_total / d_x_total) * (cur_total / y_total)

        elasticity = el_from_beta(beta)
        if boot_betas[ch]:
            samples = [el_from_beta(b) for b in boot_betas[ch]]
            ci_lo = float(np.quantile(samples, 0.025))
            ci_hi = float(np.quantile(samples, 0.975))
        else:
            ci_lo, ci_hi = elasticity, elasticity

        channel_fits.append(
            ChannelFit(
                name=ch,
                decay=params[ch]["decay"],
                k=params[ch]["k"],
                alpha=params[ch]["alpha"],
                beta=beta,
                elasticity=float(elasticity),
                elasticity_ci95=(ci_lo, ci_hi),
                current_total_spend=cur_total,
            )
        )

    trend_idx = len(channels)
    trend_coef = float(coefs[trend_idx])
    month_coefs = [float(c) for c in coefs[trend_idx + 1:]] if dates is not None else []

    caveats: list[str] = []
    if n_obs < 26:
        caveats.append("low_confidence_short_history")
    vif = _max_pairwise_vif(spend_df)
    if vif > 5:
        caveats.append("confounded_elasticities_multicollinearity")
    if r2 < 0.3:
        caveats.append("weak_fit_low_r2")

    return FitResult(
        channels=channel_fits,
        intercept=intercept,
        trend_coef=trend_coef,
        month_coefs=month_coefs,
        r_squared=float(r2),
        rmse=float(rmse),
        n_observations=int(n_obs),
        diagnostics={"max_pairwise_vif": vif, "model_caveats": caveats},
        _channel_names=channels,
        _has_seasonality=dates is not None,
        _spend_template=spend_df,
        _dates_template=np.asarray(dates) if dates is not None else None,
    )


def predict_outcome_for_totals(
    fit: FitResult, totals: dict[str, float]
) -> float:
    """
    Predict total outcome over the historical horizon if each channel's spend
    were rescaled to `totals[channel]` while preserving its temporal pattern.

    Used by the W49 optimizer to score candidate allocations.
    """
    if fit._spend_template is None:
        raise RuntimeError("FitResult is missing spend_template — refit required")
    template = fit._spend_template
    scaled_cols = {}
    params = {}
    for cf in fit.channels:
        cur = cf.current_total_spend or 1e-12
        scale = totals[cf.name] / cur
        scaled_cols[cf.name] = template[cf.name].values * scale
        params[cf.name] = {"decay": cf.decay, "k": cf.k, "alpha": cf.alpha}
    scaled_df = pd.DataFrame(scaled_cols, columns=[c.name for c in fit.channels])
    X, _ = _build_design_matrix(scaled_df, params, fit._dates_template)
    coefs = np.concatenate([
        np.array([c.beta for c in fit.channels]),
        np.array([fit.trend_coef]),
        np.array(fit.month_coefs),
    ])
    yhat = X @ coefs + fit.intercept
    return float(np.sum(yhat))


def channel_response_curve(
    fit: FitResult, channel: str, n_points: int = 40, scale_max: float = 2.5
) -> dict:
    """
    Compute total predicted outcome contribution as we sweep one channel's
    total spend from 0 to `scale_max` × current, holding others at current.
    Returns {x: spend totals, y: predicted total outcome contribution}.
    """
    if fit._spend_template is None:
        raise RuntimeError("FitResult is missing spend_template — refit required")
    cf = next(c for c in fit.channels if c.name == channel)
    template = fit._spend_template
    cur = cf.current_total_spend or 1e-12
    xs = np.linspace(0.0, scale_max * cur, n_points)
    ys: list[float] = []
    pat = template[channel].values
    pat_sum = float(pat.sum()) or 1e-12
    for x_total in xs:
        scaled = pat * (x_total / pat_sum)
        z = transform_channel(scaled, cf.decay, cf.k, cf.alpha)
        ys.append(float(cf.beta * z.sum()))
    return {"x": xs.tolist(), "y": ys, "current_x": cur}
