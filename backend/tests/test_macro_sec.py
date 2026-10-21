"""Tests for Macroeconomic indicators and SEC EDGAR regulatory filings engine."""
import pytest
from fastapi.testclient import TestClient

from backend.app.api import app
from backend.app.macro_sec import get_macro_sec_service


def test_macro_summary() -> None:
    service = get_macro_sec_service()
    summary = service.get_macro_summary()

    assert summary.as_of is not None
    assert len(summary.indicators) >= 5

    series_ids = [ind.series_id for ind in summary.indicators]
    assert "DFF" in series_ids
    assert "CPIAUCSL" in series_ids
    assert "UNRATE" in series_ids
    assert "GDPC1" in series_ids

    dff = next(ind for ind in summary.indicators if ind.series_id == "DFF")
    assert dff.latest_value > 0
    assert dff.unit == "%"


def test_macro_history() -> None:
    service = get_macro_sec_service()
    history = service.get_macro_history(series_id="CPIAUCSL", range_key="5Y")

    assert len(history) > 10
    pt = history[-1]
    assert pt.date is not None
    assert pt.value > 0


def test_sec_filings_generation() -> None:
    service = get_macro_sec_service()
    res = service.get_sec_filings(ticker="AAPL", form_filter="10-K,10-Q", limit=10)

    assert res.ticker == "AAPL"
    assert res.cik is not None
    assert len(res.filings) > 0

    forms = [f.form for f in res.filings]
    for f in forms:
        assert f in ("10-K", "10-Q")

    item = res.filings[0]
    assert item.url.startswith("https://www.sec.gov")
    assert item.filing_date is not None


def test_macro_sec_api_endpoints() -> None:
    client = TestClient(app)

    # 1. Macro summary
    resp = client.get("/api/v1/macro/summary")
    assert resp.status_code == 200
    data = resp.json()
    assert "indicators" in data
    assert len(data["indicators"]) > 0

    # 2. Macro history
    resp_hist = client.get("/api/v1/macro/history?series=DFF&range=3Y")
    assert resp_hist.status_code == 200
    hist_data = resp_hist.json()
    assert isinstance(hist_data, list)
    assert len(hist_data) > 0

    # 3. SEC filings
    resp_sec = client.get("/api/v1/sec/filings?ticker=AAPL&limit=5")
    assert resp_sec.status_code == 200
    sec_data = resp_sec.json()
    assert sec_data["ticker"] == "AAPL"
    assert "filings" in sec_data
    assert len(sec_data["filings"]) > 0
