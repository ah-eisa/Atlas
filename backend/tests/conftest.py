"""Shared fixtures.

The suite is hermetic: it never touches the network. A synthetic portfolio and
price history stand in for Yahoo Finance so the assembly layer and the API
routes can be exercised deterministically. SQLite is replaced with a temporary
database per test.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.app import store  # noqa: E402
from backend.app.config import SETTINGS, Settings  # noqa: E402
from backend.app.data import Holding, MarketData, Portfolio  # noqa: E402
from backend.app.portfolio import PortfolioAnalytics  # noqa: E402


@pytest.fixture(scope="session")
def synthetic_portfolio() -> Portfolio:
    """Three holdings: one EUR ETF, one USD stock, one USD crypto."""
    return Portfolio(
        base_currency="EUR",
        holdings=(
            Holding("AAA.AS", "Alpha ETF", "ETF", "Europe", "EUR", 100.0, 90.0, "2025-01-02"),
            Holding("BBB", "Beta Corp", "Stock", "US", "USD", 50.0, 120.0, "2025-01-02"),
            Holding("CCC-USD", "Gamma Coin", "Crypto", None, "USD", 2.0, 20000.0, "2025-01-02"),
        ),
    )


@pytest.fixture(scope="session")
def synthetic_market(synthetic_portfolio: Portfolio) -> MarketData:
    """300 trading days of correlated geometric random walks with a fixed seed."""
    rng = np.random.default_rng(7)
    index = pd.bdate_range("2025-01-02", periods=300, name="date")
    tickers = list(synthetic_portfolio.tickers)

    starts = {"AAA.AS": 100.0, "BBB": 130.0, "CCC-USD": 25000.0}
    vols = {"AAA.AS": 0.010, "BBB": 0.018, "CCC-USD": 0.040}

    native = pd.DataFrame(
        {
            ticker: starts[ticker]
            * np.exp(np.cumsum(rng.normal(0.0004, vols[ticker], len(index))))
            for ticker in tickers
        },
        index=index,
    )
    # USDEUR=X: EUR per 1 USD, i.e. base units per unit of the quote currency.
    usd_eur = pd.Series(
        0.925 * np.exp(np.cumsum(rng.normal(0.0, 0.003, len(index)))), index=index, name="USDEUR=X"
    )
    benchmark = pd.Series(
        5000.0 * np.exp(np.cumsum(rng.normal(0.0005, 0.009, len(index)))), index=index, name="^GSPC"
    )

    base = native.copy()
    base["BBB"] = native["BBB"] * usd_eur
    base["CCC-USD"] = native["CCC-USD"] * usd_eur

    return MarketData(
        prices_native=native,
        prices_base=base,
        fx={"USD": usd_eur},
        benchmark=benchmark,
        base_currency="EUR",
        fetched_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


@pytest.fixture(scope="session")
def analytics(synthetic_portfolio: Portfolio, synthetic_market: MarketData) -> PortfolioAnalytics:
    """Analytics over the synthetic dataset."""
    return PortfolioAnalytics(synthetic_portfolio, synthetic_market)


@pytest.fixture()
def temp_settings(tmp_path: Path) -> Settings:
    """Settings pointing every writable path at a per-test temporary directory."""
    return replace(
        SETTINGS,
        db_path=tmp_path / "portfolio.db",
        cache_dir=tmp_path / "cache",
        holdings_path=tmp_path / "holdings.json",
        snapshot_path=tmp_path / "snapshot.json",
        frontend_dist=tmp_path / "dist",
        seed_demo=False,
        api_key="",
    )


@pytest.fixture()
def empty_client(temp_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    """TestClient over an initialised but empty store."""
    from fastapi.testclient import TestClient

    from backend.app import api

    store.init_db(temp_settings)
    monkeypatch.setattr(api, "SETTINGS", temp_settings)
    monkeypatch.setattr(api, "_service", api.AnalyticsService(temp_settings))
    with TestClient(api.app) as client:
        yield client


@pytest.fixture()
def analytics_client(
    empty_client: object,
    temp_settings: Settings,
    analytics: PortfolioAnalytics,
    monkeypatch: pytest.MonkeyPatch,
) -> object:
    """TestClient whose analytics service is pre-warmed with synthetic data."""
    from backend.app import api

    rows = [
        {
            "ticker": holding.ticker,
            "name": holding.name,
            "asset_class": holding.asset_class,
            "region": holding.region,
            "currency": holding.currency,
            "quantity": holding.quantity,
            "cost_basis_per_unit": holding.cost_basis_per_unit,
            "acquired": holding.acquired,
        }
        for holding in analytics.portfolio.holdings
    ]
    store.replace_all(rows, "EUR", temp_settings)

    service = api._service
    service._analytics = analytics
    service._key = service._current_key()
    return empty_client
