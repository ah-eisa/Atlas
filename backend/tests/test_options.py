"""Tests for Options Chains, Black-Scholes pricing, and Option Greeks."""
import math
import pytest
from fastapi.testclient import TestClient

from backend.app.api import app
from backend.app.options import calculate_black_scholes, get_options_service
from backend.app.schemas import BlackScholesInput


def test_black_scholes_pricing_and_greeks() -> None:
    inp = BlackScholesInput(
        underlying_price=100.0,
        strike_price=100.0,
        dte=365.0,
        volatility_pct=20.0,
        risk_free_rate_pct=5.0,
        dividend_yield_pct=0.0,
    )
    out = calculate_black_scholes(inp)

    # Standard BS textbook values
    assert abs(out.call_price - 10.45) < 0.1
    assert abs(out.put_price - 5.57) < 0.1

    # Put-Call Parity: C - P = S - K * exp(-r*T)
    disc_k = 100.0 * math.exp(-0.05 * 1.0)
    parity_diff = (out.call_price - out.put_price) - (100.0 - disc_k)
    assert abs(parity_diff) < 0.15

    # Greeks bounds
    assert 0.5 < out.call_greeks.delta < 0.7
    assert -0.5 < out.put_greeks.delta < -0.3
    assert out.call_greeks.gamma > 0
    assert out.call_greeks.vega > 0
    assert out.call_greeks.theta < 0  # Time decay is negative
    assert out.put_greeks.theta < 0

    # Payoff curve
    assert len(out.payoff_curve) == 25


def test_deep_itm_and_otm_delta() -> None:
    # Deep ITM Call (S=150, K=100) -> Delta close to 1
    itm = calculate_black_scholes(
        BlackScholesInput(underlying_price=150.0, strike_price=100.0, dte=30.0, volatility_pct=20.0)
    )
    assert itm.call_greeks.delta > 0.95

    # Deep OTM Call (S=50, K=100) -> Delta close to 0
    otm = calculate_black_scholes(
        BlackScholesInput(underlying_price=50.0, strike_price=100.0, dte=30.0, volatility_pct=20.0)
    )
    assert otm.call_greeks.delta < 0.05


def test_options_chain_generation() -> None:
    service = get_options_service()
    chain = service.get_option_chain(ticker="AAPL")

    assert chain.ticker == "AAPL"
    assert chain.underlying_price > 0
    assert len(chain.expirations) > 0
    assert chain.selected_expiration is not None
    assert len(chain.calls) > 0
    assert len(chain.puts) > 0

    first_call = chain.calls[0]
    assert first_call.strike > 0


def test_options_api_endpoints() -> None:
    client = TestClient(app)

    # 1. Option Chain
    resp = client.get("/api/v1/options/chain?ticker=AAPL")
    assert resp.status_code == 200
    chain_data = resp.json()
    assert chain_data["ticker"] == "AAPL"
    assert "calls" in chain_data
    assert "puts" in chain_data

    # 2. Black-Scholes Calculator
    payload = {
        "underlying_price": 180.0,
        "strike_price": 180.0,
        "dte": 45.0,
        "volatility_pct": 28.0,
        "risk_free_rate_pct": 4.5,
        "dividend_yield_pct": 0.5,
    }
    resp_calc = client.post("/api/v1/options/calculator", json=payload)
    assert resp_calc.status_code == 200
    calc_data = resp_calc.json()
    assert calc_data["call_price"] > 0
    assert calc_data["put_price"] > 0
    assert "call_greeks" in calc_data
    assert "payoff_curve" in calc_data
