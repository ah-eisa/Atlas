"""The mandate (benchmark policy, model, sleeves), compliance, the audit trail
and scheduled reports."""

from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd
import pytest

from backend.app import audit, compliance, governance, reports, store
from backend.app.data import BenchmarkComponent, BenchmarkPolicy, Sleeve, blend_benchmark, total_return_index
from backend.app.portfolio import PortfolioAnalytics

# ---------------------------------------------------------------------------
# Benchmark policy
# ---------------------------------------------------------------------------

DAYS = pd.bdate_range("2026-01-26", periods=6, name="date")  # spans a month end


def _closes() -> pd.DataFrame:
    return pd.DataFrame(
        {"EQ": [100.0, 110.0, 99.0, 99.0, 108.9, 108.9], "BD": [100.0, 100.0, 101.0, 101.0, 101.0, 103.02]},
        index=DAYS,
    )


def test_a_daily_blend_is_the_weighted_sum_of_the_returns() -> None:
    policy = BenchmarkPolicy("60/40", (BenchmarkComponent("EQ", 0.6), BenchmarkComponent("BD", 0.4)), "daily")
    index = blend_benchmark(_closes(), None, policy)
    expected = [100.0]
    for day in range(1, 6):
        r_eq = _closes()["EQ"].iloc[day] / _closes()["EQ"].iloc[day - 1] - 1
        r_bd = _closes()["BD"].iloc[day] / _closes()["BD"].iloc[day - 1] - 1
        expected.append(expected[-1] * (1 + 0.6 * r_eq + 0.4 * r_bd))
    assert list(index) == pytest.approx(expected)


def test_a_monthly_blend_drifts_inside_the_month_and_resets_at_its_start() -> None:
    policy = BenchmarkPolicy("60/40", (BenchmarkComponent("EQ", 0.6), BenchmarkComponent("BD", 0.4)), "monthly")
    index = blend_benchmark(_closes(), None, policy)
    # January (26th to 30th): 60 in EQ and 40 in BD drift without rebalancing.
    eq, bd = 60.0, 40.0
    values = [100.0]
    for day in range(1, 5):
        if DAYS[day].month != DAYS[day - 1].month:
            total = eq + bd
            eq, bd = 0.6 * total, 0.4 * total
        eq *= _closes()["EQ"].iloc[day] / _closes()["EQ"].iloc[day - 1]
        bd *= _closes()["BD"].iloc[day] / _closes()["BD"].iloc[day - 1]
        values.append(eq + bd)
    # February 2nd: back to 60/40 of the total before the day's move.
    total = eq + bd
    eq, bd = 0.6 * total * 1.0, 0.4 * total * 1.02
    values.append(eq + bd)
    assert list(index) == pytest.approx(values)


def test_a_funds_dividends_are_reinvested_in_its_benchmark_series() -> None:
    closes = pd.Series([100.0, 98.0, 99.0], index=DAYS[:3])
    paid = pd.Series([0.0, 2.0, 0.0], index=DAYS[:3])
    index = total_return_index(closes, paid)
    assert list(index) == pytest.approx([100.0, 100.0, 100.0 * 99.0 / 98.0])


def test_the_policy_replaces_the_configured_benchmark(synthetic_portfolio: Any, synthetic_market: Any) -> None:
    policy = BenchmarkPolicy("Global 60/40", (BenchmarkComponent("ACWI", 0.6), BenchmarkComponent("AGG", 0.4)))
    analytics = PortfolioAnalytics(replace(synthetic_portfolio, benchmark_policy=policy), synthetic_market)
    assert analytics.benchmark_name == "Global 60/40"
    assert analytics.benchmark_symbol == "60% ACWI + 40% AGG"
    assert analytics.history()["benchmark_name"] == "Global 60/40"


def test_policy_weights_must_add_up(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    with pytest.raises(governance.GovernanceError, match="add up to 90.0%"):
        governance.set_benchmark_policy(
            {"components": [{"symbol": "ACWI", "weight": 0.6}, {"symbol": "AGG", "weight": 0.3}]},
            temp_settings,
            1,
        )
    saved = governance.set_benchmark_policy(
        {"components": [{"symbol": "acwi", "weight": 0.6}, {"symbol": "AGG", "weight": 0.4}]},
        temp_settings,
        1,
    )
    assert saved["name"] == "60% ACWI / 40% AGG"
    assert saved["rebalance"] == "monthly"


# ---------------------------------------------------------------------------
# Models and sleeves
# ---------------------------------------------------------------------------


def test_a_model_sets_the_targets_and_counts_what_the_portfolio_lacks(
    synthetic_portfolio: Any, synthetic_market: Any
) -> None:
    analytics = PortfolioAnalytics(
        replace(
            synthetic_portfolio,
            model_name="Balanced",
            model_weights={"AAA.AS": 0.5, "BBB": 0.3, "DDD": 0.2},
        ),
        synthetic_market,
    )
    drift = analytics._drift_payload()
    assert drift["source"] == "model"
    assert drift["model"] == "Balanced"
    rows = {row["ticker"]: row for row in drift["positions"]}
    assert rows["DDD"]["current_weight"] == 0.0
    assert rows["DDD"]["target_weight"] == pytest.approx(0.2)
    assert rows["CCC-USD"]["target_weight"] == 0.0
    weights = {p.ticker: p.allocation_pct for p in analytics.positions}
    assert rows["AAA.AS"]["drift"] == pytest.approx(weights["AAA.AS"] - 0.5, abs=1e-4)


def test_sleeves_add_up_to_the_portfolio_and_measure_their_own_return(
    synthetic_portfolio: Any, synthetic_market: Any
) -> None:
    holdings = tuple(
        replace(h, sleeve="Core" if h.ticker in ("AAA.AS", "BBB") else None) for h in synthetic_portfolio.holdings
    )
    analytics = PortfolioAnalytics(
        replace(synthetic_portfolio, holdings=holdings, sleeves=(Sleeve("Core", 0.6),)), synthetic_market
    )
    payload = analytics._sleeves_payload()
    rows = {row["name"]: row for row in payload["sleeves"]}
    assert set(rows) == {"Core", "Unassigned"}
    assert sum(row["weight"] for row in rows.values()) == pytest.approx(1.0, abs=1e-3)
    assert rows["Core"]["drift"] == pytest.approx(rows["Core"]["weight"] - 0.6, abs=1e-4)

    # One position on its own: its holdings-based return is its price return.
    alone = analytics._group_return(["AAA.AS"])
    prices = analytics.prices_base["AAA.AS"]
    assert alone == pytest.approx(float(prices.iloc[-1] / prices.iloc[0] - 1.0))


def test_sleeve_targets_cannot_exceed_the_whole(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    governance.save_sleeve({"name": "Core", "target_weight": 0.7}, temp_settings, 1)
    with pytest.raises(governance.GovernanceError, match="more than 100%"):
        governance.save_sleeve({"name": "Satellite", "target_weight": 0.4}, temp_settings, 1)
    with pytest.raises(governance.GovernanceError, match="reserved"):
        governance.save_sleeve({"name": "Cash"}, temp_settings, 1)


def test_the_mandate_reaches_the_analytics(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    holding = store.create_holding(
        {
            "ticker": "AAPL", "name": "Apple", "asset_class": "Stock", "region": "US",
            "currency": "USD", "quantity": 10, "cost_basis_per_unit": 150, "acquired": "2025-01-02",
        },
        temp_settings,
        1,
    )
    sleeve = governance.save_sleeve({"name": "Core", "target_weight": 0.8}, temp_settings, 1)
    governance.assign_sleeve(holding["id"], sleeve["id"], temp_settings, 1)
    model = governance.save_model(
        {"name": "Tech", "weights": [{"ticker": "AAPL", "weight": 0.5}, {"ticker": "MSFT", "weight": 0.5}]},
        temp_settings,
    )
    governance.set_portfolio_model(model["id"], temp_settings, 1)

    portfolio = store.build_portfolio(temp_settings, 1)
    assert portfolio.by_ticker("AAPL").sleeve == "Core"
    assert portfolio.sleeves == (Sleeve("Core", 0.8),)
    assert portfolio.model_name == "Tech"
    assert portfolio.model_weights == {"AAPL": 0.5, "MSFT": 0.5}

    governance.delete_model(model["id"], temp_settings)
    assert store.build_portfolio(temp_settings, 1).model_weights is None


# ---------------------------------------------------------------------------
# Compliance
# ---------------------------------------------------------------------------


def _exposure(**overrides: Any) -> compliance.Exposure:
    base = compliance.Exposure(
        total_value=1000.0,
        positions={"AAA": 500.0, "BBB": 300.0, "CCC": 100.0},
        asset_class_of={"AAA": "ETF", "BBB": "Stock", "CCC": "Crypto"},
        region_of={"AAA": "Europe", "BBB": "US", "CCC": "Crypto"},
        currency_of={"AAA": "EUR", "BBB": "USD", "CCC": "USD"},
        cash={"USD": 100.0},
        base_currency="EUR",
        volatility=0.18,
    )
    return replace(base, **overrides)


def _rule(kind: str, limit: float | None = None, subject: str | None = None, severity: str = "breach") -> dict:
    return {"id": 1, "kind": kind, "limit": limit, "subject": subject, "severity": severity, "enabled": True}


def test_a_hard_limit_passes_warns_and_breaches() -> None:
    exposure = _exposure()
    assert compliance.evaluate(_rule("max_position_weight", 0.6), exposure)["status"] == "pass"
    assert compliance.evaluate(_rule("max_position_weight", 0.53), exposure)["status"] == "warning"
    breach = compliance.evaluate(_rule("max_position_weight", 0.4), exposure)
    assert breach["status"] == "breach"
    assert breach["actual"] == pytest.approx(0.5)
    assert breach["offenders"] == ["AAA"]
    soft = compliance.evaluate(_rule("max_position_weight", 0.4, severity="warning"), exposure)
    assert soft["status"] == "warning"


def test_currency_exposure_counts_cash_in_that_currency() -> None:
    result = compliance.evaluate(_rule("max_currency_weight", 0.45, "usd"), _exposure())
    assert result["actual"] == pytest.approx(0.5)
    assert result["status"] == "breach"


def test_minimums_restrictions_and_counts() -> None:
    exposure = _exposure()
    assert compliance.evaluate(_rule("min_cash_weight", 0.15), exposure)["status"] == "breach"
    assert compliance.evaluate(_rule("min_asset_class_weight", 0.2, "Stock"), exposure)["status"] == "pass"
    assert compliance.evaluate(_rule("min_positions", 5), exposure)["status"] == "breach"
    restricted = compliance.evaluate(_rule("restricted_instruments", subject="CCC,ZZZ"), exposure)
    assert restricted["status"] == "breach"
    assert restricted["offenders"] == ["CCC"]
    assert compliance.evaluate(_rule("max_tracking_error", 0.05), exposure)["status"] == "unknown"


def test_an_order_is_checked_before_it_is_placed() -> None:
    before = _exposure()
    # Buying 300 of BBB: 100 from cash, 200 of new money.
    after = compliance.exposure_after_order(
        before, ticker="BBB", side="BUY", value_base=300.0, asset_class="Stock", region="US", currency="USD"
    )
    assert after.total_value == pytest.approx(1200.0)
    assert after.positions["BBB"] == pytest.approx(600.0)
    assert sum(after.cash.values()) == pytest.approx(0.0)
    # BBB is now 600 of 1,200; AAA's 500 is 41.7%, inside the limit.
    assert compliance.evaluate(_rule("max_position_weight", 0.45), after)["offenders"] == ["BBB"]

    sold = compliance.exposure_after_order(
        before, ticker="AAA", side="SELL", value_base=500.0, asset_class="ETF", region="Europe", currency="EUR"
    )
    assert "AAA" not in sold.positions
    assert sold.cash["EUR"] == pytest.approx(500.0)


def test_rule_validation_refuses_what_cannot_be_checked() -> None:
    with pytest.raises(compliance.RuleError):
        compliance.validate_rule({"kind": "max_asset_class_weight", "limit": 0.3})
    with pytest.raises(compliance.RuleError):
        compliance.validate_rule({"kind": "max_position_weight", "limit": 1.5})
    assert compliance.validate_rule({"kind": "restricted_instruments", "subject": "tsla, gme"}) == (
        "restricted_instruments",
        "GME,TSLA",
        None,
    )


def test_the_compliance_api_checks_the_portfolio_and_an_order(analytics_client: Any) -> None:
    created = analytics_client.post(
        "/api/v1/compliance/rules", json={"kind": "max_position_weight", "limit": 0.5}
    )
    assert created.status_code == 201
    analytics_client.post(
        "/api/v1/compliance/rules", json={"kind": "restricted_instruments", "subject": "GME"}
    )
    checked = analytics_client.get("/api/v1/compliance").json()
    assert checked["checked"] == 2
    largest = next(r for r in checked["results"] if r["kind"] == "max_position_weight")
    assert largest["offenders"] == ["CCC-USD"]
    assert checked["status"] == "breach"

    order = analytics_client.post(
        "/api/v1/compliance/check-order",
        json={"ticker": "GME", "order_type": "BUY", "quantity": 1, "price": 20},
    )
    assert order.status_code == 200, order.text
    assert "Instruments that may not be held" in order.json()["new_breaches"]

    invalid = analytics_client.post("/api/v1/compliance/rules", json={"kind": "max_shoe_size", "limit": 1})
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "mandate_invalid"


# ---------------------------------------------------------------------------
# Audit trail
# ---------------------------------------------------------------------------


def test_every_change_is_in_the_audit_trail_and_the_chain_holds(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    token = audit.ACTOR.set("tester")
    try:
        store.place_order(
            {"ticker": "AAPL", "order_type": "BUY", "quantity": 2, "price": 100, "executed_at": "2026-01-05"},
            temp_settings,
            1,
        )
        governance.create_rule({"kind": "min_positions", "limit": 3}, temp_settings, 1)
    finally:
        audit.ACTOR.reset(token)

    with store.connect(temp_settings) as connection:
        entries = audit.entries(connection, 1)
        assert [e["action"] for e in entries][:2] == ["rule.create", "order.place"]
        assert entries[1]["actor"] == "tester"
        assert entries[1]["detail"]["ticker"] == "AAPL"
        assert audit.verify(connection)["valid"] is True


def test_the_audit_trail_refuses_edits_and_reveals_tampering(temp_settings: Any) -> None:
    store.init_db(temp_settings)
    governance.save_sleeve({"name": "Core"}, temp_settings, 1)
    governance.save_sleeve({"name": "Income"}, temp_settings, 1)

    with sqlite3.connect(temp_settings.db_path) as connection:
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            connection.execute("UPDATE audit_log SET actor = 'someone else'")
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            connection.execute("DELETE FROM audit_log")
        # Someone with the file drops the guard and rewrites history.
        connection.execute("DROP TRIGGER audit_log_no_update")
        first = connection.execute("SELECT MIN(id) FROM audit_log").fetchone()[0]
        connection.execute("UPDATE audit_log SET actor = 'someone else' WHERE id = ?", (first,))

    with store.connect(temp_settings) as connection:
        result = audit.verify(connection)
    assert result["valid"] is False
    assert result["broken_at"] == first


# ---------------------------------------------------------------------------
# Scheduled reports
# ---------------------------------------------------------------------------


def test_the_next_run_of_each_frequency() -> None:
    after = datetime(2026, 1, 30, 9, 30).astimezone()  # a Friday
    assert reports.next_run("daily", 0, 1, 7, after) == after.replace(day=31, hour=7, minute=0)
    assert reports.next_run("daily", 0, 1, 18, after) == after.replace(hour=18, minute=0)
    monday = reports.next_run("weekly", 0, 1, 7, after)
    assert (monday.weekday(), monday.day, monday.month) == (0, 2, 2)
    # Day 31 in February runs on its last day.
    month_end = reports.next_run("monthly", 0, 31, 7, after)
    assert (month_end.month, month_end.day) == (1, 31)
    after_end = reports.next_run("monthly", 0, 31, 7, month_end)
    assert (after_end.month, after_end.day) == (2, 28)


def test_a_report_is_written_and_recorded(temp_settings: Any, analytics: PortfolioAnalytics) -> None:
    store.init_db(temp_settings)
    run = reports.run_report(temp_settings, 1, analytics=analytics)
    assert run["status"] == "done", run["error"]
    path = reports.run_file(run["id"], temp_settings, 1)
    document = path.read_text(encoding="utf-8")
    assert "<title>Main" in document
    assert "Holdings" in document and "CCC-USD" in document
    with store.connect(temp_settings) as connection:
        assert audit.entries(connection, 1)[0]["action"] == "report.run"


def test_due_schedules_run_and_move_to_their_next_slot(
    temp_settings: Any, analytics: PortfolioAnalytics, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.init_db(temp_settings)
    schedule = reports.create_schedule({"name": "Morning", "frequency": "daily", "hour": 7}, temp_settings, 1)
    calls: list[int | None] = []

    def fake_run(settings: Any, portfolio_id: int, schedule_id: int | None = None, **_: Any) -> dict:
        calls.append(schedule_id)
        return {}

    monkeypatch.setattr(reports, "run_report", fake_run)
    due = datetime.fromisoformat(schedule["next_run_at"])
    assert reports.run_due(temp_settings, now=due.replace(hour=6)) == 0
    assert reports.run_due(temp_settings, now=due) == 1
    assert calls == [schedule["id"]]
    moved = reports.list_schedules(temp_settings, 1)[0]
    assert datetime.fromisoformat(moved["next_run_at"]) > due
    assert moved["last_run_at"] is not None
