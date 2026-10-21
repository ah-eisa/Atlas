"""Methodology tests: acquisition timing, external flows and time-weighted returns.

The original project applied today's quantities to the entire price history,
which silently backtested current weights and reported it as portfolio
performance. These tests pin the replacement: a position contributes nothing
before it was acquired, its purchase is an external flow, and a contribution
never appears as investment return.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from backend.app.data import Holding, MarketData, Portfolio
from backend.app.portfolio import PortfolioAnalytics


def market_for(tickers: dict[str, float], periods: int = 6) -> MarketData:
    index = pd.bdate_range("2025-01-06", periods=periods, name="date")
    native = pd.DataFrame({ticker: price for ticker, price in tickers.items()}, index=index)
    benchmark = pd.Series(100.0, index=index)
    return MarketData(
        prices_native=native,
        prices_base=native.copy(),
        fx={},
        benchmark=benchmark,
        base_currency="EUR",
        fetched_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )


def analytics_for(holdings: tuple[Holding, ...], prices: dict[str, float]) -> PortfolioAnalytics:
    portfolio = Portfolio(base_currency="EUR", holdings=holdings)
    return PortfolioAnalytics(portfolio, market_for(prices))


def test_a_position_is_dormant_before_its_acquisition_date() -> None:
    portfolio = analytics_for(
        (
            Holding("A", "A", "Stock", "US", "EUR", 10, 10, "2025-01-06"),
            Holding("B", "B", "Stock", "US", "EUR", 10, 20, "2025-01-09"),
        ),
        {"A": 10.0, "B": 20.0},
    )
    quantities = portfolio.quantity_frame
    assert list(quantities["B"]) == pytest.approx([0, 0, 0, 10, 10, 10])
    assert list(quantities["A"]) == pytest.approx([10] * 6)
    assert list(portfolio.equity) == pytest.approx([100, 100, 100, 300, 300, 300])


def test_purchase_is_an_external_flow_not_a_return() -> None:
    portfolio = analytics_for(
        (
            Holding("A", "A", "Stock", "US", "EUR", 10, 10, "2025-01-06"),
            Holding("B", "B", "Stock", "US", "EUR", 10, 20, "2025-01-09"),
        ),
        {"A": 10.0, "B": 20.0},
    )
    assert portfolio.flows.iloc[3] == pytest.approx(200.0)
    assert portfolio.portfolio_returns.abs().max() == pytest.approx(0.0)
    assert portfolio.growth_index.iloc[-1] == pytest.approx(1.0)

    all_time = portfolio.summary()["changes"]["all"]
    assert all_time["flows"] == pytest.approx(200.0)
    assert all_time["absolute"] == pytest.approx(0.0, abs=1e-6)
    assert all_time["pct"] == pytest.approx(0.0, abs=1e-9)


def test_flow_uses_market_value_even_when_cost_basis_differs() -> None:
    """A bargain purchase must not manufacture performance on the entry day."""
    portfolio = analytics_for(
        (
            Holding("A", "A", "Stock", "US", "EUR", 10, 10, "2025-01-06"),
            Holding("B", "B", "Stock", "US", "EUR", 10, 15, "2025-01-09"),
        ),
        {"A": 10.0, "B": 20.0},
    )
    assert portfolio.flows.iloc[3] == pytest.approx(200.0)
    assert portfolio.portfolio_returns.abs().max() == pytest.approx(0.0)


def test_drawdown_follows_investment_performance_not_contributions() -> None:
    index = pd.bdate_range("2025-01-06", periods=6, name="date")
    native = pd.DataFrame({"A": [10.0, 10.0, 10.0, 10.0, 9.0, 9.0]}, index=index)
    portfolio = Portfolio(
        base_currency="EUR",
        holdings=(Holding("A", "A", "Stock", "US", "EUR", 10, 10, "2025-01-06"),),
    )
    market = MarketData(
        prices_native=native,
        prices_base=native,
        fx={},
        benchmark=pd.Series(100.0, index=index),
        base_currency="EUR",
        fetched_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )
    analytics = PortfolioAnalytics(portfolio, market)
    assert analytics.portfolio_returns.iloc[-2] == pytest.approx(-0.10)
    # A contribution on day 3 lifts market value but must not lift the growth line.
    assert analytics.growth_index.iloc[-1] == pytest.approx(0.9)


def test_acquisition_after_the_last_close_attaches_to_the_latest_observation() -> None:
    portfolio = analytics_for(
        (Holding("A", "A", "Stock", "US", "EUR", 5, 10, "2030-01-01"),),
        {"A": 10.0},
    )
    assert portfolio.equity.iloc[-1] == pytest.approx(50.0)
    assert all(value == 0 for value in portfolio.equity.iloc[:-1])


def test_incomplete_sparkline_history_is_tolerated() -> None:
    portfolio = analytics_for(
        (Holding("A", "A", "Stock", "US", "EUR", 5, 10, "2025-01-06"),),
        {"A": 10.0},
    )
    assert len(portfolio.positions[0].sparkline) == 6
    assert any("highly concentrated" in warning for warning in portfolio._warnings())
