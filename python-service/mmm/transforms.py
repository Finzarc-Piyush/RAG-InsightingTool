"""
Pure-function transforms for marketing-mix modeling.

Two transforms model the temporal and saturating dynamics of media spend:

  1. ADSTOCK — geometric carryover across periods:
         x_adstock_t = x_t + decay * x_adstock_{t-1}
     `decay ∈ [0, 1)`. decay=0 means no carryover; typical range 0.0–0.7.

  2. HILL SATURATION — diminishing returns curve:
         f(x) = x^alpha / (x^alpha + k^alpha)
     `k` is the half-saturation point (output = 0.5 when x = k).
     `alpha > 0` controls steepness (higher = sharper S-curve).
     Output is in [0, 1].

Both functions vectorise over numpy arrays and are side-effect-free, which is
required so the W48 grid-search fit can call them ~10⁴ times during model
selection without surprises.
"""
from __future__ import annotations

import numpy as np

ArrayLike = np.ndarray


def geometric_adstock(x: ArrayLike, decay: float) -> np.ndarray:
    """
    Apply geometric adstock with `decay` to a 1-D series.

    Returns a new array; never mutates `x`.
    """
    if not (0.0 <= decay < 1.0):
        raise ValueError(f"decay must be in [0, 1); got {decay}")
    arr = np.asarray(x, dtype=float).reshape(-1)
    if decay == 0.0:
        return arr.copy()
    out = np.empty_like(arr)
    out[0] = arr[0]
    for i in range(1, len(arr)):
        out[i] = arr[i] + decay * out[i - 1]
    return out


def hill_saturation(x: ArrayLike, k: float, alpha: float) -> np.ndarray:
    """
    Apply Hill saturation: f(x) = x^alpha / (x^alpha + k^alpha). Output ∈ [0, 1].
    """
    if k <= 0:
        raise ValueError(f"k must be > 0; got {k}")
    if alpha <= 0:
        raise ValueError(f"alpha must be > 0; got {alpha}")
    arr = np.asarray(x, dtype=float)
    # Floor to avoid 0**alpha edge cases when alpha < 1
    base = np.maximum(arr, 0.0)
    num = np.power(base, alpha)
    den = num + (k ** alpha)
    # Where base == 0 we want 0 (limit of f at 0 is 0)
    return np.where(base <= 0.0, 0.0, num / den)


def transform_channel(
    x: ArrayLike, decay: float, k: float, alpha: float
) -> np.ndarray:
    """Compose adstock (carryover) then Hill saturation. Convenience."""
    return hill_saturation(geometric_adstock(x, decay), k, alpha)


def adstock_grid(stride: float = 0.1) -> list[float]:
    """Decay candidates for the W48 grid search (default 0.0, 0.1, …, 0.8)."""
    return [round(d, 2) for d in np.arange(0.0, 0.9, stride)]


def hill_k_grid(spend_series: ArrayLike, n: int = 5) -> list[float]:
    """
    Half-saturation candidates anchored to the spend distribution. Picks `n`
    quantiles in [0.2, 0.8] of the non-zero spend values.
    """
    arr = np.asarray(spend_series, dtype=float).reshape(-1)
    nz = arr[arr > 0]
    if nz.size == 0:
        return [1.0]
    qs = np.linspace(0.2, 0.8, n)
    out = [float(np.quantile(nz, q)) for q in qs]
    # Ensure strictly positive and unique
    return sorted({round(max(v, 1e-6), 6) for v in out})


def hill_alpha_grid() -> list[float]:
    """Shape candidates: 0.5 (concave), 1 (Michaelis–Menten), 2, 3 (S-curve)."""
    return [0.5, 1.0, 2.0, 3.0]
