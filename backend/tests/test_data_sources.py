"""Synthetic or stale figures are labelled as such and never treated as quotes."""

from __future__ import annotations

from typing import Any

import pandas as pd
import pytest

from backend.app import api, importer, instruments, lab, options, store
from backend.app.options import OptionsService, calculate_black_scholes
from backend.app.schemas import BlackScholesInput


def _offline(*_: Any, **__: Any) -> Any:
    raise RuntimeError("provider unavailable")


def _live_instrument(ticker: str, price: float) -> instruments.Instrument:
    return instruments.Instrument(
        ticker=ticker,
        name=ticker,
        currency="USD",
        asset_class="Stock",
        region="US",
        last_price=price,
        as_of="2026-10-22",
        estimated=False,
    )


def _watch(settings: Any, ticker: str, buy: float | None, sell: float | None) -> None:
    store.upsert_watchlist_item(
        {"ticker": ticker, "name": ticker, "target_buy_price": buy, "target_sell_price": sell},
        settings,
        portfolio_id=1,
    )


def _ticker_alerts(result: dict, ticker: str) -> list[dict]:
    return [a for a in result["triggered_alerts"] if a.get("ticker") == ticker]


# --------------------------------------------------------------------------
# Watchlist prices
# --------------------------------------------------------------------------


def test_a_reference_price_is_labelled_and_never_triggers(
    temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AAPL's static reference price (228.50) is below a 300 target, but it
    is not a quote, so no buy-zone alert may fire on it."""
    store.init_db(temp_settings)
    monkeypatch.setattr(instruments, "lookup", _offline)
    _watch(temp_settings, "AAPL", buy=300.0, sell=None)
    store.create_alert_rule(
        {"metric": "price_below", "ticker": "AAPL", "threshold": 300.0},
        temp_settings,
        portfolio_id=1,
    )

    result = importer.get_watchlist_and_alerts(temp_settings, portfolio_id=1)

    item = next(w for w in result["watchlist"] if w["ticker"] == "AAPL")
    assert item["price_source"] == "reference"
    assert item["status"] == "WATCHING"
    assert item["distance_to_buy_pct"] is None
    assert _ticker_alerts(result, "AAPL") == []


def test_a_live_price_is_preferred_over_the_reference_table(
    temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.init_db(temp_settings)
    monkeypatch.setattr(instruments, "lookup", lambda t: _live_instrument(t, 190.0))
    _watch(temp_settings, "AAPL", buy=200.0, sell=None)

    result = importer.get_watchlist_and_alerts(temp_settings, portfolio_id=1)

    item = next(w for w in result["watchlist"] if w["ticker"] == "AAPL")
    assert item["price_source"] == "live"
    assert item["last_price"] == pytest.approx(190.0)
    assert item["status"] == "BUY_ZONE"
    assert len(_ticker_alerts(result, "AAPL")) == 1


def test_an_unknown_ticker_without_a_quote_has_no_price(
    temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Previously this was priced at a made-up 100.0."""
    store.init_db(temp_settings)
    monkeypatch.setattr(instruments, "lookup", _offline)
    _watch(temp_settings, "ZZZZ", buy=150.0, sell=None)

    result = importer.get_watchlist_and_alerts(temp_settings, portfolio_id=1)

    item = next(w for w in result["watchlist"] if w["ticker"] == "ZZZZ")
    assert item["price_source"] == "unavailable"
    assert item["last_price"] is None
    assert _ticker_alerts(result, "ZZZZ") == []


# --------------------------------------------------------------------------
# Options
# --------------------------------------------------------------------------


def test_live_contract_greeks_come_from_its_implied_volatility() -> None:
    row = pd.Series(
        {
            "contractSymbol": "XYZ261120C00100000",
            "strike": 100.0,
            "lastPrice": 4.2,
            "bid": float("nan"),
            "ask": 4.4,
            "volume": float("nan"),
            "openInterest": 120.0,
            "impliedVolatility": 0.30,
            "inTheMoney": False,
        }
    )

    contract = OptionsService._live_contract(row, underlying=95.0, dte=28.0, is_call=True)

    expected = calculate_black_scholes(
        BlackScholesInput(
            underlying_price=95.0,
            strike_price=100.0,
            dte=28.0,
            volatility_pct=30.0,
            risk_free_rate_pct=options.SETTINGS.risk_free_rate * 100.0,
            dividend_yield_pct=0.0,
        )
    ).call_greeks
    assert contract.delta == pytest.approx(expected.delta)
    assert contract.gamma == pytest.approx(expected.gamma)
    assert contract.theta == pytest.approx(expected.theta)
    # Missing provider values are missing, not NaN.
    assert contract.bid is None
    assert contract.volume == 0


def test_a_contract_without_implied_volatility_has_no_greeks() -> None:
    row = pd.Series({"strike": 100.0, "lastPrice": 1.0, "impliedVolatility": float("nan")})

    contract = OptionsService._live_contract(row, underlying=95.0, dte=28.0, is_call=False)

    assert contract.delta is None
    assert contract.gamma is None


def test_a_sample_chain_says_so_and_is_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    import yfinance

    monkeypatch.setattr(yfinance, "Ticker", _offline)
    service = OptionsService()

    chain = service.get_option_chain("AAPL")

    assert chain.source == "sample"
    assert service._chain_cache == {}


def test_the_chain_cache_is_bounded() -> None:
    service = OptionsService()
    chain = service._generate_sample_chain("AAPL")

    for i in range(options.CHAIN_CACHE_SIZE + 10):
        service._remember(f"T{i}_None", float(i), chain)

    assert len(service._chain_cache) == options.CHAIN_CACHE_SIZE
    assert "T0_None" not in service._chain_cache


# --------------------------------------------------------------------------
# Market ticker
# --------------------------------------------------------------------------


def test_fallback_market_quotes_are_marked_as_sample(monkeypatch: pytest.MonkeyPatch) -> None:
    import yfinance

    monkeypatch.setattr(yfinance, "download", _offline)
    monkeypatch.setattr(api, "_TICKER_CACHE", {})

    response = api.fetch_live_market_ticker()

    assert response.source == "sample"
    assert response.quotes


# --------------------------------------------------------------------------
# Attribution
# --------------------------------------------------------------------------


def test_the_attribution_reference_return_covers_the_chosen_window(analytics: Any) -> None:
    report = lab.attribution_report(analytics, period="month")

    daily = analytics.portfolio_returns
    start = pd.Timestamp(report["start_date"])
    end = pd.Timestamp(report["end_date"])
    window = daily[(daily.index > start) & (daily.index <= end)]
    expected = float((1.0 + window).prod() - 1.0)
    whole = float((1.0 + daily).prod() - 1.0)

    assert report["time_weighted_return_pct"] == pytest.approx(expected, abs=1e-4)
    assert report["time_weighted_return_pct"] != pytest.approx(whole, abs=1e-4)
