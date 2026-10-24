"""SQLite store behaviour: CRUD, constraints, revisions, import and export."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from backend.app import store
from backend.app.config import Settings
from backend.app.data import Holding, Portfolio


def row(ticker: str = "AAPL", **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ticker": ticker,
        "name": "Apple Inc.",
        "asset_class": "Stock",
        "region": "US",
        "currency": "USD",
        "quantity": 10.0,
        "cost_basis_per_unit": 180.0,
        "acquired": "2025-06-02",
    }
    payload.update(overrides)
    return payload


@pytest.fixture()
def settings(temp_settings: Settings) -> Settings:
    store.init_db(temp_settings)
    return temp_settings


def test_init_is_idempotent(settings: Settings) -> None:
    store.init_db(settings)
    assert store.list_holdings(settings) == []
    assert store.revision(settings) == 0


def test_create_get_update_delete(settings: Settings) -> None:
    created = store.create_holding(row(), settings)
    assert created["ticker"] == "AAPL"
    assert created["id"] > 0
    assert store.revision(settings) == 1

    fetched = store.get_holding(created["id"], settings)
    assert fetched["quantity"] == 10.0

    updated = store.update_holding(created["id"], row(quantity=12.5), settings)
    assert updated["quantity"] == 12.5
    assert store.revision(settings) == 2

    store.delete_holding(created["id"], settings)
    assert store.list_holdings(settings) == []
    assert store.revision(settings) == 3


def test_duplicate_tickers_are_case_insensitive(settings: Settings) -> None:
    store.create_holding(row("aapl"), settings)
    with pytest.raises(store.DuplicateTicker):
        store.create_holding(row("AAPL"), settings)


def test_unknown_holding_raises(settings: Settings) -> None:
    with pytest.raises(store.HoldingNotFound):
        store.get_holding(999, settings)
    with pytest.raises(store.HoldingNotFound):
        store.delete_holding(999, settings)


def test_currency_is_normalised_but_minor_units_are_preserved(settings: Settings) -> None:
    usd = store.create_holding(row("AAPL", currency="usd"), settings)
    assert usd["currency"] == "USD"
    pence = store.create_holding(row("VOD.L", currency="GBp"), settings)
    assert pence["currency"] == "GBp"


def test_base_currency_is_stored_and_validated(settings: Settings) -> None:
    assert store.get_base_currency(settings) == "EUR"
    assert store.set_base_currency("usd", settings) == "USD"
    assert store.get_base_currency(settings) == "USD"
    with pytest.raises(ValueError):
        store.set_base_currency("US", settings)


def test_build_portfolio_reads_rows_and_currency(settings: Settings) -> None:
    store.create_holding(row(), settings)
    store.set_base_currency("usd", settings)
    portfolio = store.build_portfolio(settings)
    assert portfolio.base_currency == "USD"
    assert portfolio.tickers == ("AAPL",)


def test_build_portfolio_rejects_an_empty_store(settings: Settings) -> None:
    with pytest.raises(store.EmptyPortfolio):
        store.build_portfolio(settings)


def test_replace_all_is_atomic_and_clears_previous_rows(settings: Settings) -> None:
    store.create_holding(row("OLD"), settings)
    count = store.replace_all([row("AAA"), row("BBB")], "USD", settings)
    assert count == 2
    assert [item["ticker"] for item in store.list_holdings(settings)] == ["AAA", "BBB"]
    assert store.get_base_currency(settings) == "USD"


def test_export_rows_omit_storage_metadata(settings: Settings) -> None:
    store.create_holding(row(), settings)
    exported = store.export_rows(settings)
    assert exported == [
        {
            "ticker": "AAPL",
            "name": "Apple Inc.",
            "asset_class": "Stock",
            "region": "US",
            "currency": "USD",
            "quantity": 10.0,
            "cost_basis_per_unit": 180.0,
            "acquired": "2025-06-02",
        }
    ]


def test_demo_seed_happens_once(tmp_path: Path, temp_settings: Settings) -> None:
    holdings = {
        "base_currency": "EUR",
        "holdings": [row("IWDA.AS", currency="EUR", name="World ETF", asset_class="ETF")],
    }
    path = tmp_path / "holdings.json"
    path.write_text(json.dumps(holdings), encoding="utf-8")
    settings = replace(temp_settings, holdings_path=path, seed_demo=True)
    store.init_db(settings)

    assert store.seed_from_demo(settings) == 1
    assert store.seed_from_demo(settings) == 0
    store.delete_holding(store.list_holdings(settings)[0]["id"], settings)
    # Deleting on purpose must not resurrect the demo on the next boot.
    assert store.seed_from_demo(settings) == 0


def test_invalid_demo_rows_are_skipped(tmp_path: Path, temp_settings: Settings) -> None:
    holdings = {
        "base_currency": "EUR",
        "holdings": [row("GOOD"), {"ticker": "BROKEN"}],
    }
    path = tmp_path / "holdings.json"
    path.write_text(json.dumps(holdings), encoding="utf-8")
    settings = replace(temp_settings, holdings_path=path, seed_demo=True)
    store.init_db(settings)
    assert store.seed_from_demo(settings) == 1
    assert [item["ticker"] for item in store.list_holdings(settings)] == ["GOOD"]


def test_a_provider_outage_falls_back_to_the_last_known_prices(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A dead provider must not take the dashboard down.

    The last known prices are worth more than an error page: the analytics
    are computed from them, and the payload says plainly how old they are.
    """
    from backend.app import data as data_module
    from backend.app.config import SETTINGS

    settings = replace(
        SETTINGS,
        cache_dir=tmp_path / "cache",
        holdings_path=tmp_path / "holdings.json",
        db_path=tmp_path / "portfolio.db",
        seed_demo=False,
    )
    portfolio = Portfolio(
        base_currency="EUR",
        holdings=(Holding("AAA.AS", "Alpha", "ETF", "Europe", "EUR", 1.0, 100.0, "2025-01-02"),),
    )

    calls = {"n": 0}

    def failing_download(symbols, start, end, optional=()):
        calls["n"] += 1
        if calls["n"] == 1:
            # First call succeeds and populates the cache.
            index = pd.bdate_range("2025-01-02", periods=40, name="date")
            frame = pd.DataFrame(
                {
                    "AAA.AS": [100.0 + i for i in range(40)],
                    settings.benchmark: [500.0 + i for i in range(40)],
                },
                index=index,
            )
            data_module._store_cache(
                data_module._cache_file(
                    settings.cache_dir, ["AAA.AS", settings.benchmark], settings.history_years
                ),
                frame,
                datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        raise RuntimeError("Yahoo Finance is unreachable")

    monkeypatch.setattr(data_module, "_download_closes", failing_download)

    market = data_module.load_market_data(portfolio, settings)
    assert market.stale is True
    assert market.fetched_at == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert len(market.prices_base) > 0


def test_place_order_buy_and_sell_with_fifo(temp_settings: Any) -> None:
    """Placing buy and sell orders tracks positions, weighted cost and realized gains."""
    import pytest
    from backend.app import store

    store.init_db(temp_settings)

    # 1. First BUY order
    buy1 = store.place_order(
        {
            "ticker": "AAPL",
            "order_type": "BUY",
            "quantity": 10.0,
            "price": 100.0,
            "executed_at": "2026-01-10",
            "notes": "Initial batch",
        },
        temp_settings,
        portfolio_id=1,
    )
    assert buy1["ticker"] == "AAPL"
    assert buy1["order_type"] == "BUY"
    assert buy1["realized_pnl"] == 0.0

    holdings = store.list_holdings(temp_settings, portfolio_id=1)
    assert len(holdings) == 1
    assert holdings[0]["ticker"] == "AAPL"
    assert holdings[0]["quantity"] == 10.0
    assert holdings[0]["cost_basis_per_unit"] == 100.0

    # 2. Second BUY order at higher price (rolling average cost)
    buy2 = store.place_order(
        {
            "ticker": "AAPL",
            "order_type": "BUY",
            "quantity": 10.0,
            "price": 200.0,
            "executed_at": "2026-02-10",
        },
        temp_settings,
        portfolio_id=1,
    )
    assert buy2["order_type"] == "BUY"

    holdings = store.list_holdings(temp_settings, portfolio_id=1)
    assert holdings[0]["quantity"] == 20.0
    assert holdings[0]["cost_basis_per_unit"] == 150.0

    # 3. SELL 10 shares at $250 consumes the oldest lot (bought at $100):
    #    gain of (250 - 100) * 10 = +1500, and the $200 lot is what remains.
    sell1 = store.place_order(
        {
            "ticker": "AAPL",
            "order_type": "SELL",
            "quantity": 10.0,
            "price": 250.0,
            "executed_at": "2026-03-01",
        },
        temp_settings,
        portfolio_id=1,
    )
    assert sell1["realized_pnl"] == 1500.0
    holdings = store.list_holdings(temp_settings, portfolio_id=1)
    assert len(holdings) == 1
    assert holdings[0]["quantity"] == 10.0
    assert holdings[0]["cost_basis_per_unit"] == 200.0
    assert holdings[0]["acquired"] == "2026-02-10"

    # 4. SELL remaining 10 shares at $100 -> loss of (100 - 200) * 10 = -1000
    sell2 = store.place_order(
        {
            "ticker": "AAPL",
            "order_type": "SELL",
            "quantity": 10.0,
            "price": 100.0,
            "executed_at": "2026-03-15",
        },
        temp_settings,
        portfolio_id=1,
    )
    assert sell2["realized_pnl"] == -1000.0
    # Position should be closed / deleted
    holdings = store.list_holdings(temp_settings, portfolio_id=1)
    assert len(holdings) == 0

    # 5. Verify transaction history and realized P&L summary
    txs = store.list_transactions(temp_settings, portfolio_id=1)
    assert len(txs) == 4

    summary = store.get_realized_pnl_summary(temp_settings, portfolio_id=1)
    assert summary["total_realized_pnl"] == 500.0
    assert summary["winning_trades"] == 1
    assert summary["losing_trades"] == 1
    assert summary["win_rate_pct"] == 0.5
    assert summary["total_trades"] == 4

    # 6. Selling non-existent stock raises OrderValidationError
    with pytest.raises(store.OrderValidationError):
        store.place_order(
            {
                "ticker": "TSLA",
                "order_type": "SELL",
                "quantity": 5.0,
                "price": 200.0,
                "executed_at": "2026-03-20",
            },
            temp_settings,
            portfolio_id=1,
        )
