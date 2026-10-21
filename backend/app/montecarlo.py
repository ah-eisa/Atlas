"""Monte Carlo simulation of future portfolio value.

Method
------
The simulation is a correlated random walk over the individual holdings, not
over the portfolio aggregate. Drawing each asset separately and summing keeps
the diversification effect intact: a 12-asset portfolio whose components are
imperfectly correlated is less volatile than any naive single-asset draw would
suggest.

1. Convert historical daily simple returns to **log returns**,
   ``x = ln(1 + r)``.
2. Estimate the mean vector ``mu`` and covariance matrix ``Sigma`` of ``x``.
3. Draw ``x_t ~ N(mu, Sigma)`` for each of 252 future trading days via a
   Cholesky factor ``L`` (``Sigma = L L^T``), so ``x = mu + L z`` with
   ``z ~ N(0, I)``. This reproduces the historical correlation structure.
4. Compound each asset multiplicatively, ``v_i(t) = v_i(0) * exp(cumsum(x_i))``,
   and sum across assets to get the portfolio path.

Why log returns: they make the compounding step exact and guarantee prices stay
positive. Sampling *simple* returns from a normal distribution can draw values
below -100%, which would imply a negative price.

Modelling assumptions (stated plainly because they matter):

* **Buy and hold.** Units are fixed; weights drift as assets diverge. No
  rebalancing, no contributions, no fees or taxes.
* **Normal log returns, constant parameters.** Real markets have fatter tails
  and time-varying volatility, so the extreme percentile bands are optimistic.
* **The past two years are representative** of the next one.

Paths are generated in batches so peak memory stays bounded regardless of the
path count; only the aggregated portfolio paths are retained.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

PERCENTILES: tuple[int, ...] = (5, 25, 50, 75, 95)


@dataclass(frozen=True)
class HistogramBin:
    """One bar of the final-value distribution.

    Attributes:
        start: Lower edge of the bin, in base currency.
        end: Upper edge of the bin, in base currency.
        count: Number of simulated paths finishing inside the bin.
        probability: ``count / total_paths``.
    """

    start: float
    end: float
    count: int
    probability: float


@dataclass(frozen=True)
class MonteCarloResult:
    """Aggregated output of the simulation.

    Attributes:
        paths: Number of simulated paths.
        horizon_days: Simulated trading days.
        start_value: Portfolio value at t=0, in base currency.
        percentile_bands: ``{"p5": [...], ...}``, one value per day including
            day 0, in base currency.
        final_values_summary: Percentiles of the terminal value.
        histogram: Distribution of terminal values.
        expected_value: Mean terminal value.
        median_value: Median (p50) terminal value.
        probability_below_start: Share of paths finishing below today's value.
        expected_return_pct: ``expected_value / start_value - 1``.
        annualized_drift_pct: Mean annualised log drift implied by ``mu``,
            expressed as a simple return.
    """

    paths: int
    horizon_days: int
    start_value: float
    percentile_bands: dict[str, list[float]]
    final_values_summary: dict[str, float]
    histogram: list[HistogramBin]
    expected_value: float
    median_value: float
    probability_below_start: float
    expected_return_pct: float
    annualized_drift_pct: float


def _psd_cholesky(cov: np.ndarray) -> np.ndarray:
    """Cholesky factor of a covariance matrix, repaired if not positive definite.

    Sample covariance matrices estimated from finite, partly collinear data can
    be numerically indefinite. If the direct factorisation fails, the matrix is
    projected onto the nearest positive semi-definite matrix by clipping its
    eigenvalues, then retried with a small ridge on the diagonal.

    Raises:
        numpy.linalg.LinAlgError: if the repaired matrix still cannot factor.
    """
    try:
        return np.linalg.cholesky(cov)
    except np.linalg.LinAlgError:
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        clipped = np.clip(eigenvalues, 1e-12, None)
        repaired = eigenvectors @ np.diag(clipped) @ eigenvectors.T
        repaired = (repaired + repaired.T) / 2.0
        ridge = 1e-10 * np.eye(repaired.shape[0])
        return np.linalg.cholesky(repaired + ridge)


def simulate(
    asset_returns: pd.DataFrame,
    position_values: pd.Series,
    *,
    paths: int = 10_000,
    horizon_days: int = 252,
    seed: int = 0,
    batch_paths: int = 1_000,
    histogram_bins: int = 48,
    trading_days_per_year: int = 252,
) -> MonteCarloResult:
    """Simulate portfolio value over ``horizon_days`` trading days.

    Args:
        asset_returns: Historical daily **simple** returns, one column per
            holding.
        position_values: Current market value of each holding in base currency,
            indexed by the same tickers as ``asset_returns``' columns.
        paths: Number of simulated paths.
        horizon_days: Trading days to simulate.
        seed: RNG seed; a fixed seed makes the committed snapshot reproducible.
        batch_paths: Paths per batch, bounding peak memory to roughly
            ``batch_paths * horizon_days * n_assets * 8`` bytes.
        histogram_bins: Bars in the terminal-value histogram.
        trading_days_per_year: Used to annualise the drift readout.

    Returns:
        A :class:`MonteCarloResult` with percentile bands, the terminal
        distribution and summary probabilities.

    Raises:
        ValueError: if inputs are empty, misaligned, or too short to estimate a
            covariance matrix.
    """
    if asset_returns.empty:
        raise ValueError("asset_returns is empty")
    if len(asset_returns) < 2:
        raise ValueError("at least two return observations are required")

    tickers = list(asset_returns.columns)
    values = position_values.reindex(tickers)
    if values.isna().any():
        missing = values.index[values.isna()].tolist()
        raise ValueError(f"no position value supplied for {missing}")

    start_values = values.to_numpy(dtype=float)
    start_value = float(start_values.sum())
    if start_value <= 0.0:
        raise ValueError("portfolio start value must be positive")

    # Log returns: exact under compounding and cannot produce negative prices.
    log_returns = np.log1p(asset_returns.to_numpy(dtype=float))
    mu = log_returns.mean(axis=0)
    cov = np.cov(log_returns, rowvar=False, ddof=1)
    cov = np.atleast_2d(cov)
    cholesky = _psd_cholesky(cov)

    rng = np.random.default_rng(seed)
    n_assets = len(tickers)
    portfolio_paths = np.empty((paths, horizon_days + 1), dtype=np.float64)
    portfolio_paths[:, 0] = start_value

    for begin in range(0, paths, batch_paths):
        size = min(batch_paths, paths - begin)
        noise = rng.standard_normal((size, horizon_days, n_assets))
        # x = mu + L z  ->  correlated log returns with the historical structure
        draws = mu + noise @ cholesky.T
        cumulative = np.cumsum(draws, axis=1)
        asset_paths = start_values * np.exp(cumulative)
        portfolio_paths[begin : begin + size, 1:] = asset_paths.sum(axis=2)

    bands = np.percentile(portfolio_paths, PERCENTILES, axis=0)
    percentile_bands = {
        f"p{pct}": [float(v) for v in bands[i]] for i, pct in enumerate(PERCENTILES)
    }

    finals = portfolio_paths[:, -1]
    counts, edges = np.histogram(finals, bins=histogram_bins)
    histogram = [
        HistogramBin(
            start=float(edges[i]),
            end=float(edges[i + 1]),
            count=int(counts[i]),
            probability=float(counts[i] / paths),
        )
        for i in range(len(counts))
    ]

    expected_value = float(finals.mean())
    portfolio_drift = float(np.average(mu, weights=start_values))

    return MonteCarloResult(
        paths=paths,
        horizon_days=horizon_days,
        start_value=start_value,
        percentile_bands=percentile_bands,
        final_values_summary={
            f"p{pct}": float(np.percentile(finals, pct)) for pct in PERCENTILES
        },
        histogram=histogram,
        expected_value=expected_value,
        median_value=float(np.percentile(finals, 50)),
        probability_below_start=float(np.mean(finals < start_value)),
        expected_return_pct=float(expected_value / start_value - 1.0),
        annualized_drift_pct=float(np.expm1(portfolio_drift * trading_days_per_year)),
    )
