"""SQLite store behaviour: CRUD, constraints, revisions, import and export."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from backend.app import store
from backend.app.config import Settings


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
