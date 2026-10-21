"""Tests for Fixed Income & Yield Curve analytics and API endpoints."""
import pytest
from fastapi.testclient import TestClient

from backend.app.api import app
from backend.app.fixed_income import FixedIncomeService, get_fixed_income_service
from backend.app.schemas import BondCalculatorInput


def test_yield_curve_generation() -> None:
    service = get_fixed_income_service()
    snapshot = service.get_yield_curve()

    assert snapshot.as_of_date is not None
    assert len(snapshot.curve_points) > 0

    tenors = [p.tenor for p in snapshot.curve_points]
    assert "10Y" in tenors
    assert "2Y" in tenors
    assert "3M" in tenors

    assert snapshot.us10y_yield > 0
    assert snapshot.us2y_yield > 0
    assert snapshot.curve_status in ("NORMAL", "INVERTED", "FLAT")

    # Spreads should be populated
    assert isinstance(snapshot.spread_10y_2y_bps, float)
    assert isinstance(snapshot.spread_10y_3m_bps, float)

    # 1M and 1Y ago curves
    if snapshot.curve_points_1y_ago:
        assert len(snapshot.curve_points_1y_ago) > 0


def test_historical_yield_series() -> None:
    service = get_fixed_income_service()
    history = service.get_historical_series(range_key="1Y")

    assert len(history) > 10
    latest_pt = history[-1]
    assert latest_pt.date is not None
    assert latest_pt.dgs10 is not None


def test_bond_calculator_par_pricing() -> None:
    # A bond with coupon equal to YTM trades at par (1000)
    inp = BondCalculatorInput(
        face_value=1000.0,
        coupon_rate=5.0,
        ytm=5.0,
        years_to_maturity=10.0,
        frequency=2,
    )
    res = FixedIncomeService.calculate_bond_metrics(inp)

    assert abs(res.price - 1000.0) < 0.05
    assert abs(res.clean_price - 1000.0) < 0.05
    assert res.modified_duration > 0
    assert res.macaulay_duration > res.modified_duration
    assert res.convexity > 0
    assert res.dv01 > 0
    assert len(res.scenarios) == 8

    # Check inverse relationship with yield
    shock_up = [s for s in res.scenarios if s.shift_bps == 100][0]
    shock_down = [s for s in res.scenarios if s.shift_bps == -100][0]

    assert shock_up.repriced_bond < res.price
    assert shock_down.repriced_bond > res.price


def test_bond_calculator_discount_and_premium() -> None:
    # Discount: coupon < ytm
    disc = FixedIncomeService.calculate_bond_metrics(
        BondCalculatorInput(face_value=1000.0, coupon_rate=3.0, ytm=6.0, years_to_maturity=5.0)
    )
    assert disc.price < 1000.0

    # Premium: coupon > ytm
    prem = FixedIncomeService.calculate_bond_metrics(
        BondCalculatorInput(face_value=1000.0, coupon_rate=7.0, ytm=4.0, years_to_maturity=5.0)
    )
    assert prem.price > 1000.0


def test_fixed_income_api_endpoints() -> None:
    client = TestClient(app)

    # 1. Yield curve
    resp = client.get("/api/v1/fixed-income/yield-curve")
    assert resp.status_code == 200
    data = resp.json()
    assert "curve_points" in data
    assert "spread_10y_2y_bps" in data
    assert "curve_status" in data

    # 2. History
    resp_hist = client.get("/api/v1/fixed-income/history?range=1Y")
    assert resp_hist.status_code == 200
    hist_data = resp_hist.json()
    assert isinstance(hist_data, list)
    assert len(hist_data) > 0

    # 3. Bond Calculator
    calc_payload = {
        "face_value": 1000.0,
        "coupon_rate": 4.5,
        "ytm": 4.2,
        "years_to_maturity": 7.0,
        "frequency": 2,
    }
    resp_calc = client.post("/api/v1/fixed-income/calculator", json=calc_payload)
    assert resp_calc.status_code == 200
    calc_data = resp_calc.json()
    assert "price" in calc_data
    assert "modified_duration" in calc_data
    assert "convexity" in calc_data
    assert "scenarios" in calc_data
