"""The trade ledger: FIFO lots, reversible orders, and lot-dated history."""

from __future__ import annotations

from typing import Any

import pytest

from backend.app import importer, store
from backend.app.data import Holding, Lot, MarketData, Portfolio
from backend.app.portfolio import PortfolioAnalytics


def _order(settings: Any, ticker: str, side: str, qty: float, price: float, day: str) -> dict:
    return store.place_order(
        {
            "ticker": ticker,
            "order_type": side,
            "quantity": qty,
            "price": price,
            "executed_at": day,
        },
        settings,
        portfolio_id=1,
    )


def _holding(settings: Any, ticker: str) -> dict | None:
    return next(
        (h for h in store.list_holdings(settings, portfolio_id=1) if h["ticker"] == ticker),
        None,
    )


def test_a_sale_spanning_lots_is_costed_lot_by_lot(temp_settings: Any) -> None:
    """15 units sold out of a 10 @ 100 lot and a 10 @ 200 lot: 10 + 5, FIFO."""
    store.init_db(temp_settings)
    _order(temp_settings, "AAPL", "BUY", 10, 100.0, "2026-01-10")
    _order(temp_settings, "AAPL", "BUY", 10, 200.0, "2026-02-10")

    sale = _order(temp_settings, "AAPL", "SELL", 15, 250.0, "2026-03-01")

    assert sale["realized_pnl"] == pytest.approx(10 * 150.0 + 5 * 50.0)
    holding = _holding(temp_settings, "AAPL")
    assert holding is not None
    assert holding["quantity"] == pytest.approx(5.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(200.0)
    assert holding["acquired"] == "2026-02-10"


def test_a_sale_cannot_use_units_bought_after_it(temp_settings: Any) -> None:
    """A backdated sale only sees the lots that were held on its date."""
    store.init_db(temp_settings)
    _order(temp_settings, "MSFT", "BUY", 10, 300.0, "2026-01-10")
    _order(temp_settings, "MSFT", "BUY", 10, 400.0, "2026-03-01")

    with pytest.raises(store.OrderValidationError, match="held on that date"):
        _order(temp_settings, "MSFT", "SELL", 15, 350.0, "2026-02-01")

    assert _holding(temp_settings, "MSFT")["quantity"] == pytest.approx(20.0)


def test_deleting_a_sale_puts_the_units_back(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    _order(temp_settings, "NVDA", "BUY", 10, 100.0, "2026-01-10")
    sale = _order(temp_settings, "NVDA", "SELL", 4, 150.0, "2026-02-10")
    assert _holding(temp_settings, "NVDA")["quantity"] == pytest.approx(6.0)

    store.delete_transaction(sale["id"], temp_settings, portfolio_id=1)

    holding = _holding(temp_settings, "NVDA")
    assert holding["quantity"] == pytest.approx(10.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(100.0)
    assert store.get_realized_pnl_summary(temp_settings, portfolio_id=1)["total_sells"] == 0


def test_deleting_the_sale_that_closed_a_position_reopens_it(temp_settings: Any) -> None:
    """The reopened position keeps the name, classification and target it had."""
    store.init_db(temp_settings)
    store.create_holding(
        {
            "ticker": "VWCE.DE",
            "name": "My world ETF",
            "asset_class": "ETF",
            "region": "Global",
            "currency": "EUR",
            "quantity": 8,
            "cost_basis_per_unit": 110.0,
            "acquired": "2025-06-01",
            "target_weight": 0.4,
        },
        temp_settings,
        portfolio_id=1,
    )
    sale = _order(temp_settings, "VWCE.DE", "SELL", 8, 130.0, "2026-01-15")
    assert sale["realized_pnl"] == pytest.approx(8 * 20.0)
    assert _holding(temp_settings, "VWCE.DE") is None

    store.delete_transaction(sale["id"], temp_settings, portfolio_id=1)

    holding = _holding(temp_settings, "VWCE.DE")
    assert holding is not None
    assert holding["name"] == "My world ETF"
    assert holding["region"] == "Global"
    assert holding["target_weight"] == pytest.approx(0.4)
    assert holding["quantity"] == pytest.approx(8.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(110.0)
    assert holding["acquired"] == "2025-06-01"


def test_deleting_a_purchase_removes_its_lot(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    _order(temp_settings, "AMZN", "BUY", 10, 100.0, "2026-01-10")
    second = _order(temp_settings, "AMZN", "BUY", 5, 200.0, "2026-02-10")

    store.delete_transaction(second["id"], temp_settings, portfolio_id=1)

    holding = _holding(temp_settings, "AMZN")
    assert holding["quantity"] == pytest.approx(10.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(100.0)
    assert holding["acquired"] == "2026-01-10"


def test_a_purchase_cannot_be_deleted_once_its_units_were_sold(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    buy = _order(temp_settings, "META", "BUY", 10, 500.0, "2026-01-10")
    _order(temp_settings, "META", "SELL", 3, 550.0, "2026-02-10")

    with pytest.raises(store.TransactionConflict, match="delete that sale first"):
        store.delete_transaction(buy["id"], temp_settings, portfolio_id=1)

    assert _holding(temp_settings, "META")["quantity"] == pytest.approx(7.0)
    assert len(store.list_transactions(temp_settings, portfolio_id=1)) == 2


def test_a_position_edited_by_hand_is_the_new_truth(temp_settings: Any) -> None:
    """After a manual edit, sales are costed against the edited position, and
    orders from before the edit only leave the ledger when deleted."""
    store.init_db(temp_settings)
    buy = _order(temp_settings, "TSLA", "BUY", 10, 100.0, "2026-01-10")
    holding = _holding(temp_settings, "TSLA")
    store.update_holding(
        holding["id"],
        {**holding, "quantity": 20.0, "cost_basis_per_unit": 120.0, "acquired": "2025-12-01"},
        temp_settings,
        portfolio_id=1,
    )

    sale = _order(temp_settings, "TSLA", "SELL", 5, 150.0, "2026-02-01")
    assert sale["realized_pnl"] == pytest.approx(5 * 30.0)

    store.delete_transaction(buy["id"], temp_settings, portfolio_id=1)
    assert _holding(temp_settings, "TSLA")["quantity"] == pytest.approx(15.0)


def test_the_api_reports_an_irreversible_deletion_as_a_conflict(empty_client: Any) -> None:
    buy = empty_client.post(
        "/api/v1/orders",
        json={
            "ticker": "SPY",
            "order_type": "BUY",
            "quantity": 4,
            "price": 500,
            "executed_at": "2026-01-10",
        },
    )
    assert buy.status_code == 201
    sell = empty_client.post(
        "/api/v1/orders",
        json={
            "ticker": "SPY",
            "order_type": "SELL",
            "quantity": 1,
            "price": 520,
            "executed_at": "2026-02-10",
        },
    )
    assert sell.status_code == 201

    response = empty_client.delete(f"/api/v1/transactions/{buy.json()['id']}")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "transaction_conflict"


def test_build_portfolio_carries_the_open_lots(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    _order(temp_settings, "QQQ", "BUY", 3, 400.0, "2026-01-10")
    _order(temp_settings, "QQQ", "BUY", 2, 450.0, "2026-02-10")

    portfolio = store.build_portfolio(temp_settings, portfolio_id=1)

    assert portfolio.by_ticker("QQQ").lots == (
        Lot(acquired="2026-01-10", quantity=3.0),
        Lot(acquired="2026-02-10", quantity=2.0),
    )


def test_each_lot_enters_the_history_on_its_own_date(synthetic_market: MarketData) -> None:
    """Units bought later are not credited with the returns before they were bought."""
    holding = Holding(
        "BBB", "Beta Corp", "Stock", "US", "USD", 50.0, 120.0, "2025-01-02",
        lots=(Lot("2025-01-02", 30.0), Lot("2025-06-02", 20.0)),
    )
    portfolio = Portfolio(base_currency="EUR", holdings=(holding,))
    analytics = PortfolioAnalytics(portfolio, synthetic_market)

    quantities = analytics.quantity_frame["BBB"]
    assert quantities.loc[:"2025-05-30"].eq(30.0).all()
    assert quantities.loc["2025-06-02":].eq(50.0).all()

    # Without a cash-flow ledger the second lot is an external contribution
    # worth its market value on the day it was bought.
    second_day = analytics.prices_base.index.searchsorted("2025-06-02")
    expected = float(analytics.prices_base["BBB"].iloc[second_day]) * 20.0
    assert float(analytics.flows.iloc[second_day]) == pytest.approx(expected)


def test_a_newest_first_broker_statement_imports_every_trade(temp_settings: Any) -> None:
    """The sale is listed before the purchase it closes, as brokers export."""
    store.init_db(temp_settings)
    csv_text = (
        "ticker,order_type,quantity,cost_basis_per_unit,acquired\n"
        "MSFT,SELL,5,400,2026-03-01\n"
        "MSFT,BUY,5,300,2026-01-01\n"
    )

    result = importer.commit_csv_import(csv_text, settings=temp_settings, portfolio_id=1)

    assert result["imported_trades"] == 2
    assert result["warnings"] == []
    sale = next(
        tx for tx in store.list_transactions(temp_settings, portfolio_id=1)
        if tx["order_type"] == "SELL"
    )
    assert sale["realized_pnl"] == pytest.approx(5 * 100.0)


def test_same_day_trades_are_bought_before_they_are_sold() -> None:
    csv_text = (
        "ticker,order_type,quantity,cost_basis_per_unit,acquired\n"
        "AAPL,SELL,1,210,2026-01-05\n"
        "AAPL,BUY,1,200,2026-01-05\n"
        "AAPL,BUY,2,190,2026-01-02\n"
    )

    trades = importer.preview_csv_import(csv_text)["trades"]

    assert [(t["executed_at"], t["order_type"]) for t in trades] == [
        ("2026-01-02", "BUY"),
        ("2026-01-05", "BUY"),
        ("2026-01-05", "SELL"),
    ]
