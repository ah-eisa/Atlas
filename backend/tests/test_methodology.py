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
def _attribution_market(fx_rates: list[float], prices: list[float]) -> MarketData:
    """A six-day market: constant holdings, one moving price, one moving rate."""
    index = pd.bdate_range("2025-01-06", periods=len(prices), name="date")
    native = pd.DataFrame({"A": prices}, index=index)
    fx = pd.Series(fx_rates, index=index, name="USDEUR=X")
    base = native.copy()
    base["A"] = native["A"] * fx
    return MarketData(
        prices_native=native,
        prices_base=base,
        fx={"USD": fx},
        benchmark=pd.Series(100.0, index=index),
        base_currency="EUR",
        fetched_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )


def test_unrealised_pnl_splits_into_price_and_currency_effects() -> None:
    """The attribution must reconcile exactly with the reported P&L.

    A multi-currency book gains from two different things: the instrument
    moving, and the currency moving. Reporting one number for both hides
    both, so the split has to be an identity rather than an estimate.
    """
    prices = [100.0] * 5 + [120.0]
    rates = [0.90] * 6
    market = _attribution_market(rates, prices)
    portfolio = Portfolio(
        base_currency="EUR",
        holdings=(Holding("A", "A", "Stock", "US", "USD", 10, 100.0, "2025-01-06"),),
    )
    position = PortfolioAnalytics(portfolio, market).positions[0]

    # 10 units bought at 100 with EUR 0.90 per USD, now at 120 with the same rate.
    assert position.price_effect == pytest.approx(180.0)
    assert position.fx_effect == pytest.approx(0.0)
    assert position.price_effect + position.fx_effect == pytest.approx(position.unrealized_pnl)

    # Now the currency weakens to 0.80: the price effect is unchanged (it is
    # measured at the entry rate) and the currency effect is the difference.
    market = _attribution_market([0.90] * 5 + [0.80], prices)
    position = PortfolioAnalytics(portfolio, market).positions[0]
    assert position.price_effect == pytest.approx(180.0)
    assert position.fx_effect == pytest.approx(-120.0)
    assert position.price_effect + position.fx_effect == pytest.approx(position.unrealized_pnl)

    summary = PortfolioAnalytics(portfolio, market).summary()
    attribution = summary["fx_attribution"]
    assert (
        attribution["price_effect"] + attribution["fx_effect"] + attribution["unattributed"]
    ) == pytest.approx(attribution["total"])
    assert attribution["total"] == pytest.approx(summary["total_unrealized_pnl"])


def test_a_position_acquired_before_the_history_has_no_entry_price() -> None:
    """No entry price means no split, and the remainder is reported as such."""
    analytics = analytics_for(
        (Holding("A", "A", "Stock", "US", "EUR", 10, 100.0, "2024-01-01"),),
        {"A": 120.0},
    )
    position = analytics.positions[0]
    assert position.price_native_at_acquisition is None
    assert position.price_effect is None
    assert position.fx_effect is None

    attribution = analytics.summary()["fx_attribution"]
    assert attribution["price_effect"] == 0.0
    assert attribution["unattributed"] == pytest.approx(position.unrealized_pnl)


def test_a_recorded_ledger_replaces_the_estimated_flows() -> None:
    """With a ledger, the flow series is the recorded money.

    Without one, flows are estimated from the dates the positions were
    acquired. That is an approximation; a recorded contribution is not.
    """
    from backend.app.data import CashFlow

    # One position opens the window, so the second one is an interior flow.
    opener = Holding("A", "A", "Stock", "US", "EUR", 10, 100.0, "2025-01-06")
    later = Holding("B", "B", "Stock", "US", "EUR", 5, 50.0, "2025-01-09")
    prices = {"A": 100.0, "B": 50.0}

    estimated = analytics_for((opener, later), prices)
    assert estimated.flow_source == "estimated"
    assert estimated.flows.abs().sum() > 0

    recorded = Portfolio(
        base_currency="EUR",
        holdings=(opener, later),
        cash_flows=(CashFlow(occurred_on="2025-01-09", amount=12345.0, note="Contribution"),),
    )
    with_ledger = PortfolioAnalytics(recorded, market_for(prices))
    assert with_ledger.flow_source == "ledger"
    assert with_ledger.flows.abs().sum() == pytest.approx(12345.0)