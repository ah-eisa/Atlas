"""Tests for Portfolio Lab: Stress Testing, Brinson Attribution & Portfolio X-Ray."""

from __future__ import annotations

import pytest

from backend.app import lab


def test_brinson_fachler_identity() -> None:
    """Allocation + Selection + Interaction must equal Active Return."""
    segments = [
        lab.Segment(key="Stock", wp=0.60, wb=0.50, rp=0.14, rb=0.10),
        lab.Segment(key="Bond", wp=0.25, wb=0.35, rp=0.03, rb=0.04),
        lab.Segment(key="Crypto", wp=0.15, wb=0.15, rp=0.25, rb=0.20),
    ]
    res = lab.brinson_fachler(segments)
    totals = res["totals"]
    assert totals["weights_normalised"] is False
    expected_port = 0.60 * 0.14 + 0.25 * 0.03 + 0.15 * 0.25
    expected_bench = 0.50 * 0.10 + 0.35 * 0.04 + 0.15 * 0.20
    assert totals["portfolio_return_pct"] == pytest.approx(expected_port, abs=1e-5)
    assert totals["benchmark_return_pct"] == pytest.approx(expected_bench, abs=1e-5)
    assert totals["residual_pct"] == pytest.approx(0.0, abs=1e-5)
    assert (
        totals["allocation_pct"] + totals["selection_pct"] + totals["interaction_pct"]
    ) == pytest.approx(totals["active_return_pct"], abs=1e-5)


def test_brinson_fachler_normalises_unbalanced_weights() -> None:
    segments = [
        lab.Segment(key="US", wp=2.0, wb=1.0, rp=0.10, rb=0.08),
        lab.Segment(key="Europe", wp=2.0, wb=3.0, rp=0.04, rb=0.05),
    ]
    res = lab.brinson_fachler(segments)
    assert res["totals"]["weights_normalised"] is True
    assert res["totals"]["residual_pct"] == pytest.approx(0.0, abs=1e-5)


def test_stress_report_presets_and_custom(analytics) -> None:
    report = lab.stress_report(analytics)
    assert report["base_currency"] == "EUR"
    assert len(report["results"]) == len(lab.SCENARIOS)
    gfc = next(r for r in report["results"] if r["key"] == "gfc_2008")
    assert gfc["pnl"] < 0
    assert gfc["value_after"] == pytest.approx(gfc["value_before"] + gfc["pnl"], abs=0.05)

    custom = lab.stress_report(
        analytics,
        scenario_keys=["rates_up_100"],
        custom=lab.Shock(equity_pct=-0.15, rates_bps=75.0, usd_pct=0.05, gold_pct=0.02, crypto_pct=-0.30),
    )
    keys = [r["key"] for r in custom["results"]]
    assert keys == ["rates_up_100", "custom"]


def test_attribution_report_dimensions_and_custom_benchmark(analytics) -> None:
    for group_by in ("asset_class", "region", "currency"):
        rep = lab.attribution_report(analytics, period="all", group_by=group_by)
        assert rep["group_by"] == group_by
        assert rep["benchmark_mode"] == "equal_weight"
        assert rep["totals"]["residual_pct"] == pytest.approx(0.0, abs=1e-5)
        assert len(rep["segments"]) >= 2

    custom_rep = lab.attribution_report(
        analytics,
        period="month",
        group_by="asset_class",
        benchmark=[
            lab.BenchmarkSegment(key="ETF", weight=0.50, return_pct=0.02),
            lab.BenchmarkSegment(key="Stock", weight=0.40, return_pct=0.03),
            lab.BenchmarkSegment(key="Crypto", weight=0.10, return_pct=-0.05),
        ],
    )
    assert custom_rep["benchmark_mode"] == "custom"
    assert custom_rep["totals"]["residual_pct"] == pytest.approx(0.0, abs=1e-5)


def test_xray_report_structure(analytics) -> None:
    xray = lab.xray_report(analytics)
    assert xray["positions"] == 3
    assert xray["headline"]["effective_holdings"] > 1.0
    assert len(xray["findings"]) >= 1
    assert len(xray["risk_vs_capital"]) == 3
    assert set(xray["exposure"].keys()) == {"asset_class", "region", "currency"}
    assert "clusters" in xray["overlap"]


def test_lab_api_endpoints(analytics_client) -> None:
    r_scen = analytics_client.get("/api/v1/portfolio/scenarios")
    assert r_scen.status_code == 200
    assert len(r_scen.json()["scenarios"]) >= 7

    r_stress = analytics_client.get("/api/v1/portfolio/stress")
    assert r_stress.status_code == 200
    assert len(r_stress.json()["results"]) >= 7

    r_post_stress = analytics_client.post(
        "/api/v1/portfolio/stress",
        json={
            "scenarios": ["covid_2020"],
            "custom": {
                "equity_pct": -0.15,
                "rates_bps": 75,
                "usd_pct": 0.05,
                "gold_pct": 0.03,
                "crypto_pct": -0.25,
            },
        },
    )
    assert r_post_stress.status_code == 200
    assert [x["key"] for x in r_post_stress.json()["results"]] == ["covid_2020", "custom"]

    r_attr = analytics_client.get("/api/v1/portfolio/attribution?period=ytd&group_by=region")
    assert r_attr.status_code == 200
    assert r_attr.json()["group_by"] == "region"

    r_post_attr = analytics_client.post(
        "/api/v1/portfolio/attribution",
        json={
            "period": "all",
            "group_by": "asset_class",
            "benchmark": [
                {"key": "ETF", "weight": 0.6, "return_pct": 0.08},
                {"key": "Stock", "weight": 0.3, "return_pct": 0.12},
                {"key": "Crypto", "weight": 0.1, "return_pct": 0.20},
            ],
        },
    )
    assert r_post_attr.status_code == 200
    assert r_post_attr.json()["benchmark_mode"] == "custom"

    r_xray = analytics_client.get("/api/v1/portfolio/xray")
    assert r_xray.status_code == 200
    assert "headline" in r_xray.json()
    assert "risk_vs_capital" in r_xray.json()

    r_search = analytics_client.get("/api/v1/search?q=NVDA+10-K")
    assert r_search.status_code == 200
    assert r_search.json()["candidate_ticker"] == "NVDA"
    assert "scenarios" in r_search.json()

