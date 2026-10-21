"""Tests for the Monte Carlo engine.

A stochastic simulation cannot be pinned to exact values, so these tests assert
the properties that must hold: determinism under a fixed seed, correctly
ordered percentile bands, a normalised histogram, and preservation of the
input correlation structure.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backend.app import montecarlo


@pytest.fixture()
def returns_frame() -> pd.DataFrame:
    """Two correlated assets plus one independent asset, 400 observations."""
    rng = np.random.default_rng(11)
    n = 400
    shared = rng.normal(0.0005, 0.010, n)
    return pd.DataFrame(
        {
            "A": shared + rng.normal(0.0, 0.002, n),
            "B": shared + rng.normal(0.0, 0.003, n),
            "C": rng.normal(0.0003, 0.020, n),
        },
        index=pd.bdate_range("2024-01-01", periods=n),
    )


@pytest.fixture()
def values() -> pd.Series:
    return pd.Series({"A": 50_000.0, "B": 30_000.0, "C": 20_000.0})


def simulate(returns_frame: pd.DataFrame, values: pd.Series, **kwargs: object) -> montecarlo.MonteCarloResult:
    params: dict[str, object] = {
        "paths": 2_000,
        "horizon_days": 60,
        "seed": 42,
        "batch_paths": 500,
        "histogram_bins": 20,
    }
    params.update(kwargs)
    return montecarlo.simulate(returns_frame, values, **params)  # type: ignore[arg-type]


def test_start_value_is_the_sum_of_positions(returns_frame, values) -> None:
    result = simulate(returns_frame, values)
    assert result.start_value == pytest.approx(100_000.0)
    assert all(band[0] == pytest.approx(100_000.0) for band in result.percentile_bands.values())


def test_bands_have_one_point_per_day_including_day_zero(returns_frame, values) -> None:
    result = simulate(returns_frame, values, horizon_days=60)
    assert set(result.percentile_bands) == {"p5", "p25", "p50", "p75", "p95"}
    assert all(len(band) == 61 for band in result.percentile_bands.values())


def test_percentile_bands_are_monotonically_ordered(returns_frame, values) -> None:
    bands = simulate(returns_frame, values).percentile_bands
    for day in range(61):
        assert (
            bands["p5"][day]
            <= bands["p25"][day]
            <= bands["p50"][day]
            <= bands["p75"][day]
            <= bands["p95"][day]
        )


def test_bands_widen_over_the_horizon(returns_frame, values) -> None:
    bands = simulate(returns_frame, values).percentile_bands
    early = bands["p95"][1] - bands["p5"][1]
    late = bands["p95"][-1] - bands["p5"][-1]
    assert late > early


def test_a_fixed_seed_is_reproducible(returns_frame, values) -> None:
    first = simulate(returns_frame, values)
    second = simulate(returns_frame, values)
    assert first.expected_value == pytest.approx(second.expected_value)
    assert first.percentile_bands["p50"] == pytest.approx(second.percentile_bands["p50"])


def test_different_seeds_give_different_paths(returns_frame, values) -> None:
    first = simulate(returns_frame, values, seed=1)
    second = simulate(returns_frame, values, seed=2)
    assert first.expected_value != second.expected_value


def test_batching_does_not_change_the_distribution(returns_frame, values) -> None:
    """Batch size is a memory optimisation; results must be statistically equal."""
    small = simulate(returns_frame, values, batch_paths=100, paths=4_000)
    large = simulate(returns_frame, values, batch_paths=4_000, paths=4_000)
    assert small.median_value == pytest.approx(large.median_value, rel=0.03)


def test_histogram_is_a_normalised_partition(returns_frame, values) -> None:
    result = simulate(returns_frame, values)
    assert sum(bucket.count for bucket in result.histogram) == result.paths
    assert sum(bucket.probability for bucket in result.histogram) == pytest.approx(1.0)
    for previous, following in zip(result.histogram, result.histogram[1:]):
        assert previous.end == pytest.approx(following.start)


def test_probability_below_start_is_a_valid_probability(returns_frame, values) -> None:
    result = simulate(returns_frame, values)
    assert 0.0 <= result.probability_below_start <= 1.0


def test_simulated_values_stay_positive(returns_frame, values) -> None:
    """Log-return sampling must never produce a negative portfolio value."""
    result = simulate(returns_frame, values, horizon_days=252)
    assert result.percentile_bands["p5"][-1] > 0.0
    assert result.final_values_summary["p5"] > 0.0


def test_correlation_structure_is_preserved(returns_frame, values) -> None:
    """A/B are built to co-move; a portfolio of them must be tighter than C alone.

    If the simulation drew each asset independently, diversification would be
    overstated; if it ignored covariance entirely, it would be understated.
    Comparing an all-C portfolio against the correlated A/B pair detects both.
    """
    correlated = simulate(returns_frame, pd.Series({"A": 50_000.0, "B": 50_000.0, "C": 0.0}))
    volatile = simulate(returns_frame, pd.Series({"A": 0.0, "B": 0.0, "C": 100_000.0}))

    correlated_spread = correlated.final_values_summary["p95"] - correlated.final_values_summary["p5"]
    volatile_spread = volatile.final_values_summary["p95"] - volatile.final_values_summary["p5"]
    assert correlated_spread < volatile_spread


def test_expected_value_is_consistent_with_the_median_under_positive_drift(returns_frame, values) -> None:
    """Compounded lognormal outcomes are right-skewed: mean >= median."""
    result = simulate(returns_frame, values, horizon_days=252)
    assert result.expected_value >= result.median_value


def test_rejects_empty_returns(values) -> None:
    with pytest.raises(ValueError, match="empty"):
        montecarlo.simulate(pd.DataFrame(), values)


def test_rejects_missing_position_values(returns_frame) -> None:
    with pytest.raises(ValueError, match="no position value"):
        montecarlo.simulate(returns_frame, pd.Series({"A": 1.0}))


def test_rejects_a_non_positive_start_value(returns_frame) -> None:
    with pytest.raises(ValueError, match="must be positive"):
        montecarlo.simulate(returns_frame, pd.Series({"A": 0.0, "B": 0.0, "C": 0.0}))


def test_psd_cholesky_repairs_a_singular_matrix() -> None:
    """A perfectly collinear covariance matrix is not positive definite."""
    singular = np.array([[1.0, 1.0], [1.0, 1.0]])
    factor = montecarlo._psd_cholesky(singular)
    reconstructed = factor @ factor.T
    assert np.allclose(reconstructed, singular, atol=1e-6)


def test_simulation_survives_a_perfectly_collinear_pair() -> None:
    rng = np.random.default_rng(3)
    base = rng.normal(0.0004, 0.01, 300)
    frame = pd.DataFrame(
        {"A": base, "B": base},  # identical series -> singular covariance
        index=pd.bdate_range("2024-01-01", periods=300),
    )
    result = montecarlo.simulate(
        frame, pd.Series({"A": 500.0, "B": 500.0}), paths=500, horizon_days=30, seed=5
    )
    assert result.start_value == pytest.approx(1000.0)
    assert all(np.isfinite(result.percentile_bands["p50"]))
