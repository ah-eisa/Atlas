"""Contract and behaviour tests for the HTTP API.

Two layers are covered:

* the JSON contract of the analytic payloads (against the synthetic dataset),
* the live application surface: bootstrap, position CRUD, validation, export,
  API-key protection, error shapes and the empty-portfolio path.

No test touches the network or the real database.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

import pytest

from backend.app import api, instruments
from backend.app.portfolio import PortfolioAnalytics

ANALYTICS_ROUTES = [
    "/api/v1/holdings",
    "/api/v1/portfolio/summary",
    "/api/v1/portfolio/history",
    "/api/v1/portfolio/returns",
    "/api/v1/portfolio/risk",
    "/api/v1/portfolio/montecarlo",
]

LEGACY_ROUTES = [
    "/holdings",
    "/portfolio/summary",
    "/portfolio/history",
    "/portfolio/returns",
    "/portfolio/risk",
    "/portfolio/montecarlo",
]


def assert_json_safe(payload: Any) -> None:
    json.loads(json.dumps(payload, allow_nan=False))


def detail(response: Any) -> dict[str, Any]:
    body = response.json()
    assert isinstance(body["detail"], dict), body
    return body["detail"]


def position(**overrides: Any) -> dict[str, Any]:
    payload = {
        "ticker": "AAPL",
        "name": "Apple Inc.",
        "asset_class": "Stock",
        "region": "US",
        "currency": "USD",
        "quantity": 10,
        "cost_basis_per_unit": 180.0,
        "acquired": (date.today() - timedelta(days=30)).isoformat(),
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# Empty portfolio
# ---------------------------------------------------------------------------


def test_bootstrap_on_an_empty_portfolio_is_usable(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/bootstrap")
    assert response.status_code == 200
    payload = response.json()
    assert payload["analytics"] is None
    assert payload["positions"] == []
    assert payload["source"] == "api"
    assert payload["settings"]["benchmark"] == "^SP500TR"
    # The portfolio's prices are dividend-adjusted, so the default benchmark
    # must be a total-return series too; otherwise alpha is biased downwards
    # by roughly the portfolio's dividend yield.
    assert payload["settings"]["benchmark_includes_dividends"] is True
    assert_json_safe(payload)


def test_analytics_route_reports_empty_portfolio_as_409(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/portfolio/summary")
    assert response.status_code == 409
    assert detail(response)["code"] == "empty_portfolio"


def test_liveness_is_fast_and_does_not_require_positions(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["positions"] == 0
    assert payload["version"] == api.API_VERSION


# ---------------------------------------------------------------------------
# Position CRUD
# ---------------------------------------------------------------------------


def test_create_list_update_and_delete_a_position(empty_client: Any) -> None:
    created = empty_client.post("/api/v1/positions", json=position())
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["ticker"] == "AAPL"
    assert row["quantity"] == 10
    assert row["id"] > 0

    listed = empty_client.get("/api/v1/positions")
    assert listed.status_code == 200
    assert [item["ticker"] for item in listed.json()] == ["AAPL"]

    updated = empty_client.put(
        f"/api/v1/positions/{row['id']}",
        json=position(quantity=12.5, cost_basis_per_unit=170.0),
    )
    assert updated.status_code == 200
    assert updated.json()["quantity"] == 12.5

    deleted = empty_client.delete(f"/api/v1/positions/{row['id']}")
    assert deleted.status_code == 204
    assert empty_client.get("/api/v1/positions").json() == []


def test_duplicate_tickers_are_rejected_case_insensitively(empty_client: Any) -> None:
    assert empty_client.post("/api/v1/positions", json=position(ticker="aapl")).status_code == 201
    duplicate = empty_client.post("/api/v1/positions", json=position(ticker="AAPL"))
    assert duplicate.status_code == 409
    assert detail(duplicate)["code"] == "duplicate_ticker"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("quantity", 0),
        ("quantity", -3),
        ("cost_basis_per_unit", -1),
        ("asset_class", "Magic"),
        ("currency", "EURO"),
        ("ticker", "BAD TICKER"),
        ("name", "   "),
        ("acquired", (date.today() + timedelta(days=1)).isoformat()),
    ],
)
def test_invalid_positions_return_field_level_422(empty_client: Any, field: str, value: Any) -> None:
    response = empty_client.post("/api/v1/positions", json=position(**{field: value}))
    assert response.status_code == 422, response.text
    body = detail(response)
    assert body["code"] == "validation_error"
    assert any(field in item["field"] for item in body["fields"])


def test_unknown_position_returns_404(empty_client: Any) -> None:
    response = empty_client.delete("/api/v1/positions/999")
    assert response.status_code == 404
    assert detail(response)["code"] == "holding_not_found"


def test_updated_at_changes_when_a_position_is_edited(empty_client: Any) -> None:
    row = empty_client.post("/api/v1/positions", json=position()).json()
    updated = empty_client.put(f"/api/v1/positions/{row['id']}", json=position(name="Apple")).json()
    assert updated["name"] == "Apple"
    assert updated["created_at"] <= updated["updated_at"]


# ---------------------------------------------------------------------------
# Settings and export
# ---------------------------------------------------------------------------


def test_base_currency_can_be_changed_and_is_validated(empty_client: Any) -> None:
    changed = empty_client.put("/api/v1/settings/base-currency", json={"base_currency": "usd"})
    assert changed.status_code == 200
    assert changed.json()["base_currency"] == "USD"

    invalid = empty_client.put("/api/v1/settings/base-currency", json={"base_currency": "US"})
    assert invalid.status_code == 422


def test_export_json_and_csv(empty_client: Any) -> None:
    empty_client.post("/api/v1/positions", json=position())

    as_json = empty_client.get("/api/v1/portfolio/export?format=json")
    assert as_json.status_code == 200
    assert as_json.headers["content-disposition"].startswith("attachment")
    assert as_json.json()["holdings"][0]["ticker"] == "AAPL"

    as_csv = empty_client.get("/api/v1/portfolio/export?format=csv")
    assert as_csv.status_code == 200
    assert as_csv.headers["content-type"].startswith("text/csv")
    assert "AAPL" in as_csv.text
    assert as_csv.text.splitlines()[0].startswith("ticker,name,asset_class")

    invalid = empty_client.get("/api/v1/portfolio/export?format=xlsx")
    assert invalid.status_code == 422


# ---------------------------------------------------------------------------
# Instrument lookup (provider mocked)
# ---------------------------------------------------------------------------


def test_instrument_lookup_returns_metadata(empty_client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        instruments,
        "lookup",
        lambda ticker: instruments.Instrument(
            ticker=ticker.upper(),
            name="Apple Inc.",
            currency="USD",
            asset_class="Stock",
            region="US",
            last_price=190.5,
            as_of="2026-10-20",
            estimated=False,
        ),
    )
    response = empty_client.get("/api/v1/instruments/aapl")
    assert response.status_code == 200
    assert response.json()["currency"] == "USD"


def test_instrument_lookup_maps_provider_failures(empty_client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(_: str) -> None:
        raise instruments.InstrumentError("no recent price data for NOPE")

    monkeypatch.setattr(instruments, "lookup", missing)
    response = empty_client.get("/api/v1/instruments/NOPE")
    assert response.status_code == 404
    assert detail(response)["code"] == "instrument_not_found"


# ---------------------------------------------------------------------------
# Analytics contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ANALYTICS_ROUTES)
def test_analytics_routes_return_a_json_safe_envelope(
    analytics_client: Any, analytics: PortfolioAnalytics, route: str
) -> None:
    response = analytics_client.get(route)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert_json_safe(payload)
    assert payload["as_of"] == analytics.as_of
    assert payload["base_currency"] == "EUR"
    assert "generated_at" in payload


@pytest.mark.parametrize("route", LEGACY_ROUTES)
def test_legacy_aliases_keep_working(analytics_client: Any, route: str) -> None:
    assert analytics_client.get(route).status_code == 200


def test_bootstrap_includes_positions_and_analytics(analytics_client: Any) -> None:
    response = analytics_client.get("/api/v1/bootstrap")
    assert response.status_code == 200
    payload = response.json()
    assert payload["analytics"] is not None
    assert len(payload["positions"]) == 3
    assert payload["analytics"]["summary"]["total_value"] > 0
    assert payload["warnings"] == []


def test_holdings_allocations_sum_to_one(analytics: PortfolioAnalytics) -> None:
    payload = analytics.holdings()
    assert sum(h["allocation_pct"] for h in payload["holdings"]) == pytest.approx(1.0, abs=1e-3)
    assert sum(h["value_base"] for h in payload["holdings"]) == pytest.approx(
        payload["total_value"], abs=0.05
    )


def test_usd_holdings_are_converted_into_the_base_currency(analytics: PortfolioAnalytics) -> None:
    holdings = {h["ticker"]: h for h in analytics.holdings()["holdings"]}
    rate = float(analytics.market.rate_series("USD").iloc[-1])
    assert holdings["BBB"]["price_base"] == pytest.approx(
        holdings["BBB"]["price_native"] * rate, rel=1e-4
    )
    assert holdings["AAA.AS"]["price_base"] == pytest.approx(
        holdings["AAA.AS"]["price_native"], rel=1e-9
    )


def test_summary_pnl_reconciles_with_value_minus_cost(analytics: PortfolioAnalytics) -> None:
    payload = analytics.summary()
    assert payload["total_unrealized_pnl"] == pytest.approx(
        payload["total_value"] - payload["total_cost"], abs=0.05
    )


def test_summary_period_changes_share_the_same_end_value(analytics: PortfolioAnalytics) -> None:
    payload = analytics.summary()
    for period, change in payload["changes"].items():
        assert change["period"] == period
        assert change["end_value"] == pytest.approx(payload["total_value"], abs=0.05)
        assert change["absolute"] == pytest.approx(
            change["end_value"] - change["start_value"] - change["flows"], abs=0.05
        )


def test_history_series_are_parallel_arrays(analytics: PortfolioAnalytics) -> None:
    payload = analytics.history()
    length = len(payload["dates"])
    assert length == 300
    for key in ("portfolio", "portfolio_value", "benchmark_rebased", "drawdown_pct"):
        assert len(payload[key]) == length
    for series in payload["per_holding"].values():
        assert len(series) == length
    assert payload["methodology"].startswith("time-weighted")


def test_history_per_holding_values_sum_to_market_value(analytics: PortfolioAnalytics) -> None:
    payload = analytics.history()
    for day in (0, 150, 299):
        total = sum(series[day] for series in payload["per_holding"].values())
        assert total == pytest.approx(payload["portfolio_value"][day], abs=0.05)
    assert payload["portfolio"][-1] == pytest.approx(payload["portfolio_value"][-1], abs=0.05)


def test_history_benchmark_is_rebased_onto_the_portfolio_start(analytics: PortfolioAnalytics) -> None:
    payload = analytics.history()
    assert payload["benchmark_rebased"][0] == pytest.approx(payload["portfolio"][0], abs=0.05)


def test_history_drawdown_is_never_positive(analytics: PortfolioAnalytics) -> None:
    assert max(analytics.history()["drawdown_pct"]) <= 0.0


def test_returns_payload_includes_monthly_yearly_and_histogram(analytics: PortfolioAnalytics) -> None:
    payload = analytics.returns()
    assert payload["observations"] == 299
    assert payload["positive_days"] + payload["negative_days"] <= payload["observations"]
    assert 0.0 <= payload["hit_rate_pct"] <= 1.0
    assert payload["worst_day"]["pct"] <= payload["best_day"]["pct"]
    assert payload["monthly_pct"]
    assert payload["yearly_pct"]
    assert payload["histogram"]
    assert len(payload["daily_pct"]) == payload["observations"]


def test_risk_exposes_every_metric_the_ui_renders(analytics: PortfolioAnalytics) -> None:
    payload = analytics.risk()
    assert payload["volatility_annualized_pct"] > 0
    assert payload["max_drawdown"]["pct"] <= 0.0
    assert payload["beta"]["benchmark"] == "^SP500TR"
    assert payload["benchmark"]["includes_dividends"] is True
    assert payload["calmar_ratio"] is not None
    assert payload["benchmark"]["tracking_error_pct"] is not None
    assert payload["benchmark"]["information_ratio"] is not None
    assert payload["benchmark"]["up_capture"] is not None
    assert 0 <= payload["concentration"]["herfindahl"] <= 1
    assert payload["concentration"]["effective_holdings"] >= 1
    assert len(payload["risk_contribution"]) == 3
    assert sum(row["weight"] for row in payload["risk_contribution"]) == pytest.approx(1.0, abs=1e-3)


def test_risk_var_rises_with_confidence_and_has_cvar(analytics: PortfolioAnalytics) -> None:
    var = analytics.risk()["value_at_risk"]
    assert var["99"]["parametric_pct"] > var["95"]["parametric_pct"]
    assert var["99"]["cvar_pct"] >= var["95"]["cvar_pct"]
    tolerance = 1e-4 * analytics.total_value
    for level in ("95", "99"):
        assert var[level]["historical_value"] == pytest.approx(
            var[level]["historical_pct"] * analytics.total_value, abs=tolerance
        )
        assert var[level]["cvar_value"] == pytest.approx(
            var[level]["cvar_pct"] * analytics.total_value, abs=tolerance
        )


def test_risk_correlation_matrix_is_square_and_unit_diagonal(analytics: PortfolioAnalytics) -> None:
    correlation = analytics.risk()["correlation"]
    tickers, matrix = correlation["tickers"], correlation["matrix"]
    assert len(tickers) == 3
    assert all(len(row) == 3 for row in matrix)
    for i in range(3):
        assert matrix[i][i] == pytest.approx(1.0)
        for j in range(3):
            assert matrix[i][j] == pytest.approx(matrix[j][i])


def test_montecarlo_dates_align_with_the_bands(analytics: PortfolioAnalytics) -> None:
    payload = analytics.montecarlo()
    assert payload["dates"][0] == payload["as_of"]
    assert len(payload["dates"]) == payload["horizon_days"] + 1
    for band in payload["percentile_bands"].values():
        assert len(band) == len(payload["dates"])
    assert payload["start_value"] == pytest.approx(analytics.summary()["total_value"], abs=0.05)


def test_montecarlo_reports_a_valid_probability_and_ordered_finals(analytics: PortfolioAnalytics) -> None:
    payload = analytics.montecarlo()
    assert 0.0 <= payload["probability_below_start_pct"] <= 1.0
    finals = payload["final_values"]
    assert finals["p5"] < finals["p25"] < finals["p50"] < finals["p75"] < finals["p95"]


def test_all_payloads_covers_the_snapshot_contract(analytics: PortfolioAnalytics) -> None:
    payloads = analytics.all_payloads()
    assert set(payloads) == {
        "/health",
        "/holdings",
        "/portfolio/summary",
        "/portfolio/history",
        "/portfolio/returns",
        "/portfolio/risk",
        "/portfolio/montecarlo",
    }
    assert_json_safe(payloads)


# ---------------------------------------------------------------------------
# Cross-cutting HTTP behaviour
# ---------------------------------------------------------------------------


def test_cors_headers_are_present_for_a_browser_origin(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/health", headers={"Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_security_headers_and_request_id_are_attached(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/health", headers={"X-Request-ID": "test-request"})
    assert response.headers["X-Request-ID"] == "test-request"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"


def test_unknown_api_route_is_a_structured_404(empty_client: Any) -> None:
    response = empty_client.get("/api/v1/nope")
    assert response.status_code == 404
    assert detail(response)["code"] == "not_found"


def test_analytics_failure_surfaces_as_503(
    analytics_client: Any, analytics: PortfolioAnalytics, monkeypatch: pytest.MonkeyPatch
) -> None:
    def explode() -> dict[str, Any]:
        raise RuntimeError("yahoo unreachable")

    monkeypatch.setattr(analytics, "summary", explode)
    response = analytics_client.get("/api/v1/portfolio/summary")
    assert response.status_code == 503
    assert detail(response)["code"] == "analytics_unavailable"
    assert "yahoo unreachable" in detail(response)["message"]


def test_api_key_protects_data_but_not_liveness(
    empty_client: Any, temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from dataclasses import replace

    secured = replace(temp_settings, api_key="s3cret")
    monkeypatch.setattr(api, "SETTINGS", secured)
    monkeypatch.setattr(api, "_service", api.AnalyticsService(secured))

    assert empty_client.get("/api/v1/health").status_code == 200
    assert empty_client.get("/api/v1/positions").status_code == 401

    authorised = empty_client.get("/api/v1/positions", headers={"X-API-Key": "s3cret"})
    assert authorised.status_code == 200


def test_a_rejected_api_key_still_carries_cors_headers(
    empty_client: Any, temp_settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 401 must be readable by the browser.

    Regression test: the API-key guard used to sit outside the CORS
    middleware, so its early 401 response reached the browser without
    ``Access-Control-Allow-Origin``. The page could not read the error body
    and reported a generic CORS failure instead of "unauthorised".
    """
    from dataclasses import replace

    secured = replace(temp_settings, api_key="s3cret")
    monkeypatch.setattr(api, "SETTINGS", secured)
    monkeypatch.setattr(api, "_service", api.AnalyticsService(secured))

    response = empty_client.get(
        "/api/v1/positions",
        headers={"Origin": "http://127.0.0.1:5173"},
    )

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert response.json()["detail"]["code"] == "unauthorized"
