"""Portfolio accounting: fees, taxes, dividends, corporate actions, FX cash,
and units that were sold - each pinned to the figure it must produce."""

from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pandas as pd
import pytest

from backend.app import store
from backend.app.data import Holding, MarketData, Portfolio
from backend.app.ledger import LedgerError, LedgerEvent, replay
from backend.app.portfolio import PortfolioAnalytics

# ---------------------------------------------------------------------------
# The replay, on its own
# ---------------------------------------------------------------------------


def _ev(key: str, kind: str, on: str, seq: int = 0, **fields: Any) -> LedgerEvent:
    return LedgerEvent(key=key, kind=kind, on=on, seq=seq or int(key.split(":")[1]), **fields)


def test_a_purchase_fee_is_part_of_the_cost_and_a_sale_fee_comes_off_the_proceeds() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="AAA", quantity=10, price=100.0, fee=5.0, currency="USD"),
            _ev("tx:2", "SELL", "2026-02-05", ticker="AAA", quantity=10, price=120.0, fee=6.0, currency="USD"),
        ]
    )
    sale = result.sales["tx:2"]
    assert sale.cost == pytest.approx(1005.0)
    assert sale.proceeds == pytest.approx(1194.0)
    assert sale.realized == pytest.approx(189.0)
    cash = [amount for m in result.movements for _, amount in m.cash]
    assert sum(cash) == pytest.approx(-1005.0 + 1194.0)
    fees = sum(m.value for m in result.movements if m.category == "fee")
    assert fees == pytest.approx(11.0)


def test_a_tax_on_a_sale_is_reported_and_paid_but_not_part_of_the_realised_result() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="AAA", quantity=10, price=100.0),
            _ev("tx:2", "SELL", "2026-02-05", ticker="AAA", quantity=10, price=150.0, tax=75.0),
        ]
    )
    assert result.sales["tx:2"].realized == pytest.approx(500.0)
    sale_cash = [m for m in result.movements if m.key == "tx:2" and m.cash]
    assert sale_cash[0].cash[0][1] == pytest.approx(1500.0 - 75.0)
    assert sum(m.value for m in result.movements if m.category == "tax") == pytest.approx(75.0)


def test_a_split_multiplies_the_units_and_divides_the_cost() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="NVDA", quantity=10, price=400.0),
            _ev("ev:2", "SPLIT", "2026-03-02", ticker="NVDA", ratio=4.0),
            _ev("tx:3", "SELL", "2026-04-01", ticker="NVDA", quantity=20, price=120.0),
        ]
    )
    assert result.sales["tx:3"].realized == pytest.approx(20 * (120.0 - 100.0))
    assert result.position("NVDA") == pytest.approx((20.0, 100.0, "2026-01-05"))
    assert result.splits["NVDA"] == [("2026-03-02", 4.0)]


def test_a_reverse_split_consolidates_the_units() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="XYZ", quantity=1000, price=2.0),
            _ev("ev:2", "SPLIT", "2026-02-02", ticker="XYZ", ratio=0.1),
        ]
    )
    assert result.position("XYZ") == pytest.approx((100.0, 20.0, "2026-01-05"))


def test_units_created_by_a_split_cannot_be_sold_before_it() -> None:
    with pytest.raises(LedgerError, match="only 10 held on that date"):
        replay(
            [
                _ev("tx:1", "BUY", "2026-01-05", ticker="NVDA", quantity=10, price=400.0),
                _ev("ev:2", "SPLIT", "2026-03-02", ticker="NVDA", ratio=4.0),
                _ev("tx:3", "SELL", "2026-02-01", ticker="NVDA", quantity=20, price=120.0),
            ]
        )


def test_a_symbol_change_moves_the_lots_with_their_dates_and_cost() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2021-06-01", ticker="FB", quantity=10, price=330.0, currency="USD"),
            _ev("ev:2", "SYMBOL_CHANGE", "2022-06-09", ticker="FB", new_ticker="META", ratio=1.0),
        ]
    )
    assert "FB" not in result.lots
    assert result.position("META") == pytest.approx((10.0, 330.0, "2021-06-01"))
    assert result.currencies["META"] == "USD"
    with pytest.raises(LedgerError):
        replay(
            [
                _ev("tx:1", "BUY", "2021-06-01", ticker="FB", quantity=10, price=330.0),
                _ev("ev:2", "SYMBOL_CHANGE", "2022-06-09", ticker="FB", new_ticker="META", ratio=1.0),
                _ev("tx:3", "SELL", "2022-07-01", ticker="FB", quantity=1, price=170.0),
            ]
        )


def test_a_spin_off_splits_the_cost_between_parent_and_child() -> None:
    """100 units costing 5,000; one child per two parents; 20% of the cost moves."""
    result = replay(
        [
            _ev("tx:1", "BUY", "2023-01-03", ticker="GE", quantity=100, price=50.0),
            _ev("ev:2", "SPINOFF", "2023-01-04", ticker="GE", new_ticker="GEHC", ratio=0.5, cost_fraction=0.2),
        ]
    )
    assert result.position("GE") == pytest.approx((100.0, 40.0, "2023-01-03"))
    assert result.position("GEHC") == pytest.approx((50.0, 20.0, "2023-01-03"))
    parent_cost = 100 * 40.0
    child_cost = 50 * 20.0
    assert parent_cost + child_cost == pytest.approx(5000.0)


def test_a_return_of_capital_lowers_the_cost_and_any_excess_is_a_gain() -> None:
    lowered = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="REIT", quantity=10, price=20.0),
            _ev("ev:2", "RETURN_OF_CAPITAL", "2026-02-05", ticker="REIT", amount=50.0),
        ]
    )
    assert lowered.position("REIT")[1] == pytest.approx(15.0)
    assert "ev:2" not in lowered.sales

    beyond = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="REIT", quantity=10, price=20.0),
            _ev("ev:2", "RETURN_OF_CAPITAL", "2026-02-05", ticker="REIT", amount=250.0),
        ]
    )
    assert beyond.position("REIT")[1] == pytest.approx(0.0)
    assert beyond.sales["ev:2"].realized == pytest.approx(50.0)


def test_a_dividend_pays_its_net_amount_and_reports_the_tax_withheld() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-05", ticker="KO", quantity=100, price=60.0, currency="USD"),
            _ev("ev:2", "DIVIDEND", "2026-04-01", ticker="KO", amount=51.0, tax=7.65),
        ]
    )
    dividend = [m for m in result.movements if m.key == "ev:2" and m.cash][0]
    assert dividend.cash == (("USD", pytest.approx(43.35)),)
    assert sum(m.value for m in result.movements if m.category == "dividend") == pytest.approx(51.0)
    assert sum(m.value for m in result.movements if m.category == "withholding") == pytest.approx(7.65)


def test_a_conversion_moves_cash_between_currencies_less_its_fee() -> None:
    result = replay(
        [
            _ev(
                "ev:1", "FX", "2026-01-05",
                currency="EUR", amount=1000.0, to_currency="USD", to_amount=1080.0, fee=2.0,
            )
        ]
    )
    assert result.movements[0].cash == (("EUR", -1002.0), ("USD", 1080.0))


def test_a_hand_edit_replaces_the_unit_events_recorded_before_it() -> None:
    result = replay(
        [
            _ev("tx:1", "BUY", "2026-01-10", ticker="TSLA", quantity=10, price=100.0),
            _ev("ev:2", "ADJUSTMENT", "2025-12-01", ticker="TSLA", quantity=20, price=120.0),
            _ev("tx:3", "SELL", "2026-02-01", ticker="TSLA", quantity=5, price=150.0),
        ]
    )
    assert result.superseded == {"tx:1"}
    assert result.sales["tx:3"].realized == pytest.approx(5 * 30.0)
    assert result.position("TSLA") == pytest.approx((15.0, 120.0, "2025-12-01"))


def test_the_order_of_recording_does_not_change_the_result() -> None:
    events = [
        _ev("tx:1", "BUY", "2026-01-05", ticker="AAA", quantity=10, price=100.0, fee=1.0),
        _ev("tx:2", "BUY", "2026-02-05", ticker="AAA", quantity=10, price=200.0),
        _ev("ev:3", "SPLIT", "2026-03-02", ticker="AAA", ratio=2.0),
        _ev("tx:4", "SELL", "2026-04-01", ticker="AAA", quantity=25, price=90.0, fee=2.0),
        _ev("ev:5", "DIVIDEND", "2026-05-01", ticker="AAA", amount=30.0, tax=4.5),
    ]
    expected = replay(events)
    shuffled = events[:]
    random.Random(4).shuffle(shuffled)
    again = replay(shuffled)
    assert again.position("AAA") == pytest.approx(expected.position("AAA"))
    assert again.sales["tx:4"].realized == pytest.approx(expected.sales["tx:4"].realized)
    # 20 split-adjusted units from the first lot (cost 50.05) and 5 from the
    # second (cost 100), sold at 90 with a fee of 2.
    assert expected.sales["tx:4"].realized == pytest.approx(25 * 90.0 - 2.0 - (20 * 50.05 + 5 * 100.0))


# ---------------------------------------------------------------------------
# The history: units sold, cash, dividends, splits and currencies
# ---------------------------------------------------------------------------

INDEX = pd.bdate_range("2026-01-05", periods=60, name="date")


def _market(
    prices: dict[str, np.ndarray],
    *,
    usd: np.ndarray | None = None,
    dividends: dict[str, pd.Series] | None = None,
    dividends_in_prices: bool = False,
) -> MarketData:
    native = pd.DataFrame(prices, index=INDEX)
    rate = pd.Series(usd if usd is not None else np.full(len(INDEX), 0.9), index=INDEX)
    base = native * rate.to_numpy()[:, None]
    return MarketData(
        prices_native=native,
        prices_base=base,
        fx={"USD": rate},
        benchmark=pd.Series(np.linspace(100.0, 110.0, len(INDEX)), index=INDEX),
        base_currency="EUR",
        fetched_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        dividends=dividends or {},
        dividends_in_prices=dividends_in_prices,
    )


def _portfolio(holdings: tuple[Holding, ...], events: list[LedgerEvent]) -> Portfolio:
    return Portfolio(
        base_currency="EUR",
        holdings=holdings,
        ledger=tuple(events),
        currencies={"AAA": "USD", "BBB": "USD"},
    )


def _day(n: int) -> str:
    return INDEX[n].strftime("%Y-%m-%d")


def test_units_sold_are_part_of_the_history_until_the_day_they_were_sold() -> None:
    prices = {"AAA": np.linspace(100.0, 159.0, 60)}
    events = [
        _ev("tx:1", "BUY", _day(5), ticker="AAA", quantity=10, price=float(prices["AAA"][5]), currency="USD"),
        _ev("tx:2", "SELL", _day(30), ticker="AAA", quantity=4, price=float(prices["AAA"][30]), currency="USD"),
    ]
    holding = Holding("AAA", "Alpha", "Stock", "US", "USD", 6.0, float(prices["AAA"][5]), _day(5))
    analytics = PortfolioAnalytics(_portfolio((holding,), events), _market(prices))

    units = analytics.quantity_frame["AAA"]
    assert units.iloc[5:30].eq(10.0).all()
    assert units.iloc[30:].eq(6.0).all()

    # The proceeds stay in the portfolio as cash: 4 units at the day's price.
    assert float(analytics.cash_frame["USD"].iloc[-1]) == pytest.approx(
        4 * float(prices["AAA"][30]) * 0.9
    )
    # A sale at the close changes nothing that day but what the money is in.
    day = analytics.active_index.get_loc(INDEX[30])
    before = float(analytics.equity.iloc[day - 1])
    after = float(analytics.equity.iloc[day])
    expected_return = 10 * (prices["AAA"][30] - prices["AAA"][29]) * 0.9 / before
    assert after / before - 1.0 == pytest.approx(expected_return)
    # No money came in or went out apart from the purchase.
    assert float(analytics.flows.sum()) == pytest.approx(0.0)


def test_a_purchase_cash_cannot_pay_for_is_money_the_owner_added_at_its_cost() -> None:
    prices = {"AAA": np.linspace(100.0, 159.0, 60)}
    events = [
        _ev("tx:1", "BUY", _day(10), ticker="AAA", quantity=5, price=105.0, fee=3.0, currency="USD"),
    ]
    holding = Holding("AAA", "Alpha", "Stock", "US", "USD", 5.0, 105.6, _day(10))
    analytics = PortfolioAnalytics(
        _portfolio((holding,), [_ev("cf:9", "DEPOSIT", _day(2), amount=100.0, currency="EUR"), *events]),
        _market(prices),
    )
    day = analytics.active_index.get_loc(INDEX[10])
    # 528 USD at 0.9 is 475.20 EUR; the 100 EUR deposited first pays part of it.
    assert float(analytics.flows.iloc[day]) == pytest.approx(5 * 105.0 * 0.9 + 3.0 * 0.9 - 100.0)
    assert float(analytics.cash_frame.sum(axis=1).iloc[-1]) == pytest.approx(0.0)


def test_dividends_from_the_market_are_cash_and_not_counted_twice() -> None:
    prices = {"AAA": np.full(60, 100.0)}
    paid = pd.Series([1.5], index=[INDEX[20]])
    holding = Holding("AAA", "Alpha", "Stock", "US", "USD", 10.0, 100.0, _day(3))
    events = [_ev("tx:1", "BUY", _day(3), ticker="AAA", quantity=10, price=100.0, currency="USD")]

    split_adjusted = PortfolioAnalytics(
        _portfolio((holding,), events), _market(prices, dividends={"AAA": paid})
    )
    # 10 units x 1.50 USD at 0.9.
    assert float(split_adjusted.cash_frame["USD"].iloc[-1]) == pytest.approx(10 * 1.5 * 0.9)
    report = split_adjusted.summary()["ledger"]
    assert report["dividends"] == pytest.approx(13.5)
    assert report["dividends_source"] == "market"
    # The price did not move, so the whole return is the dividend.
    assert float(split_adjusted.growth_index.iloc[-1]) - 1.0 == pytest.approx(13.5 / 900.0)

    in_prices = PortfolioAnalytics(
        _portfolio((holding,), events),
        _market(prices, dividends={"AAA": paid}, dividends_in_prices=True),
    )
    assert in_prices.cash_frame.sum(axis=1).abs().max() == pytest.approx(0.0)
    assert in_prices.summary()["ledger"]["dividends_source"] == "in_prices"


def test_a_recorded_dividend_replaces_the_derived_one_and_its_withholding_is_a_cost() -> None:
    prices = {"AAA": np.full(60, 100.0)}
    paid = pd.Series([1.5], index=[INDEX[20]])
    holding = Holding("AAA", "Alpha", "Stock", "US", "USD", 10.0, 100.0, _day(3))
    events = [
        _ev("tx:1", "BUY", _day(3), ticker="AAA", quantity=10, price=100.0, currency="USD"),
        _ev("ev:2", "DIVIDEND", _day(25), ticker="AAA", amount=15.0, tax=2.25, currency="USD"),
    ]
    analytics = PortfolioAnalytics(
        _portfolio((holding,), events), _market(prices, dividends={"AAA": paid})
    )
    assert analytics.market_dividends == []
    assert float(analytics.cash_frame["USD"].iloc[-1]) == pytest.approx((15.0 - 2.25) * 0.9)
    report = analytics.summary()["ledger"]
    assert report["dividends"] == pytest.approx(13.5)
    assert report["withholding"] == pytest.approx(2.03, abs=0.01)
    assert report["net_income"] == pytest.approx((15.0 - 2.25) * 0.9, abs=0.01)


def test_history_before_a_split_is_restated_in_todays_units() -> None:
    # Split-adjusted prices: 25 before the split, 25 after (a 4-for-1 at 100).
    prices = {"AAA": np.full(60, 25.0)}
    holding = Holding("AAA", "Alpha", "Stock", "US", "USD", 40.0, 25.0, _day(2))
    events = [
        _ev("tx:1", "BUY", _day(2), ticker="AAA", quantity=10, price=100.0, currency="USD"),
        _ev("ev:2", "SPLIT", _day(30), ticker="AAA", ratio=4.0),
    ]
    analytics = PortfolioAnalytics(_portfolio((holding,), events), _market(prices))
    units = analytics.quantity_frame["AAA"]
    assert units.iloc[2:].eq(40.0).all()
    # The position's value never jumps: the split is not a return.
    assert analytics.portfolio_returns.abs().max() == pytest.approx(0.0)


def test_foreign_cash_moves_with_its_currency() -> None:
    usd = np.linspace(0.90, 0.99, 60)
    analytics = PortfolioAnalytics(
        _portfolio(
            (Holding("AAA", "Alpha", "Stock", "US", "USD", 1.0, 100.0, _day(1)),),
            [
                _ev("tx:1", "BUY", _day(1), ticker="AAA", quantity=1, price=100.0, currency="USD"),
                _ev("cf:2", "DEPOSIT", _day(5), amount=900.0, currency="EUR"),
                _ev("ev:3", "FX", _day(5), currency="EUR", amount=900.0, to_currency="USD", to_amount=900.0 / usd[5]),
            ],
        ),
        _market({"AAA": np.full(60, 100.0)}, usd=usd),
    )
    cash_value = analytics.cash_frame["USD"]
    assert float(cash_value.iloc[-1]) == pytest.approx(900.0 / usd[5] * usd[-1])
    # The currency gain on the cash is part of the return, not a flow.
    total = float(analytics.growth_index.iloc[-1]) - 1.0
    assert total > 0.09


def test_a_portfolio_without_a_ledger_is_measured_as_before(analytics: PortfolioAnalytics) -> None:
    assert analytics.ledger_replay is None
    assert analytics.summary()["ledger"] is None
    assert analytics.holdings()["cash"] == []


# ---------------------------------------------------------------------------
# The store and the API
# ---------------------------------------------------------------------------


def _order(settings: Any, ticker: str, side: str, qty: float, price: float, day: str, **extra: Any) -> dict:
    return store.place_order(
        {"ticker": ticker, "order_type": side, "quantity": qty, "price": price, "executed_at": day, **extra},
        settings,
        portfolio_id=1,
    )


def _holding(settings: Any, ticker: str) -> dict | None:
    return next((h for h in store.list_holdings(settings, 1) if h["ticker"] == ticker), None)


def test_an_order_fee_is_part_of_the_cost_and_of_the_realised_result(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    _order(temp_settings, "AAPL", "BUY", 10, 100.0, "2026-01-10", fee=5.0)
    assert _holding(temp_settings, "AAPL")["cost_basis_per_unit"] == pytest.approx(100.5)
    sale = _order(temp_settings, "AAPL", "SELL", 4, 150.0, "2026-02-10", fee=2.0)
    assert sale["realized_pnl"] == pytest.approx(4 * 150.0 - 2.0 - 4 * 100.5)
    assert store.get_realized_pnl_summary(temp_settings, 1)["total_fees"] == pytest.approx(7.0)


def test_a_recorded_split_restates_the_position_and_cannot_be_removed_under_a_sale(
    temp_settings: Any,
) -> None:
    store.init_db(temp_settings)
    _order(temp_settings, "NVDA", "BUY", 10, 400.0, "2026-01-10")
    split = store.create_ledger_event(
        {"kind": "SPLIT", "occurred_on": "2026-03-02", "ticker": "NVDA", "ratio": 4},
        temp_settings,
        1,
    )
    holding = _holding(temp_settings, "NVDA")
    assert holding["quantity"] == pytest.approx(40.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(100.0)

    _order(temp_settings, "NVDA", "SELL", 30, 120.0, "2026-04-01")
    with pytest.raises(store.TransactionConflict):
        store.delete_ledger_event(split["id"], temp_settings, 1)
    assert _holding(temp_settings, "NVDA")["quantity"] == pytest.approx(10.0)


def test_a_symbol_change_opens_the_new_position_with_the_old_ones_description(
    temp_settings: Any,
) -> None:
    store.init_db(temp_settings)
    store.create_holding(
        {
            "ticker": "FB",
            "name": "Facebook",
            "asset_class": "Stock",
            "region": "US",
            "currency": "USD",
            "quantity": 10,
            "cost_basis_per_unit": 300.0,
            "acquired": "2021-06-01",
            "target_weight": 0.1,
        },
        temp_settings,
        1,
    )
    store.create_ledger_event(
        {"kind": "SYMBOL_CHANGE", "occurred_on": "2022-06-09", "ticker": "FB", "new_ticker": "META", "ratio": 1},
        temp_settings,
        1,
    )
    assert _holding(temp_settings, "FB") is None
    meta = _holding(temp_settings, "META")
    assert meta["quantity"] == pytest.approx(10.0)
    assert meta["cost_basis_per_unit"] == pytest.approx(300.0)
    assert meta["acquired"] == "2021-06-01"
    assert meta["currency"] == "USD"
    assert meta["asset_class"] == "Stock"
    assert meta["target_weight"] == pytest.approx(0.1)


def test_the_ledger_api_records_lists_and_refuses(empty_client: Any) -> None:
    buy = empty_client.post(
        "/api/v1/orders",
        json={"ticker": "KO", "order_type": "BUY", "quantity": 100, "price": 60, "fee": 1.5, "executed_at": "2026-01-10"},
    )
    assert buy.status_code == 201
    assert buy.json()["fee"] == pytest.approx(1.5)

    dividend = empty_client.post(
        "/api/v1/ledger-events",
        json={"kind": "DIVIDEND", "occurred_on": "2026-04-01", "ticker": "KO", "amount": 51, "tax": 7.65},
    )
    assert dividend.status_code == 201
    assert dividend.json()["currency"]

    refused = empty_client.post(
        "/api/v1/ledger-events",
        json={"kind": "SPLIT", "occurred_on": "2025-01-01", "ticker": "KO", "ratio": 2},
    )
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "ledger_validation_error"

    listed = empty_client.get("/api/v1/ledger-events").json()
    assert [event["kind"] for event in listed if event["kind"] != "ADJUSTMENT"] == ["DIVIDEND"]

    deleted = empty_client.delete(f"/api/v1/ledger-events/{dividend.json()['id']}")
    assert deleted.status_code == 204


def test_an_older_database_keeps_its_positions_and_results(temp_settings: Any) -> None:
    """A version-6 database: one order, one synthetic lot from a hand edit, then a sale."""
    import sqlite3

    store.init_db(temp_settings)
    _order(temp_settings, "TSLA", "BUY", 10, 100.0, "2026-01-10")
    holding = _holding(temp_settings, "TSLA")
    store.update_holding(
        holding["id"],
        {**holding, "quantity": 20.0, "cost_basis_per_unit": 120.0, "acquired": "2025-12-01"},
        temp_settings,
        1,
    )
    sale = _order(temp_settings, "TSLA", "SELL", 5, 150.0, "2026-02-01")

    # Turn it back into what version 6 stored: no ledger events, a synthetic
    # lot of the edited position, and the schema version before this one.
    with sqlite3.connect(temp_settings.db_path) as connection:
        connection.execute("DELETE FROM ledger_events")
        connection.execute("DELETE FROM lots")
        connection.execute(
            "INSERT INTO lots (portfolio_id, ticker, acquired, quantity_original, quantity_remaining,"
            " cost_per_unit, transaction_id, created_at)"
            " SELECT 1, 'TSLA', '2025-12-01', 20, 15, 120, NULL, created_at"
            " FROM transactions WHERE order_type = 'SELL'"
        )
        connection.execute("UPDATE transactions SET seq = 0")
        connection.execute("PRAGMA user_version = 6")

    store.init_db(temp_settings)

    holding = _holding(temp_settings, "TSLA")
    assert holding["quantity"] == pytest.approx(15.0)
    assert holding["cost_basis_per_unit"] == pytest.approx(120.0)
    trades = {tx["id"]: tx for tx in store.list_transactions(temp_settings, 1)}
    assert trades[sale["id"]]["realized_pnl"] == pytest.approx(5 * 30.0)
    assert trades[sale["id"]]["superseded"] is False
