"""HTTP surface for the portfolio analytics application.

Design notes
------------
* The analytics engine is pure and expensive (price download + Monte Carlo).
  One process-wide instance is cached here, keyed by the SQLite revision
  counter, so every mutation invalidates it automatically.
* The API is versioned under ``/api/v1``. The original unversioned paths are
  kept as thin aliases because the committed snapshot and older clients still
  use them; new clients should use ``/api/v1/bootstrap``.
* Errors are machine-readable: every failure returns
  ``{"detail": {"code": "...", "message": "..."}}`` with a stable code.
* If ``frontend/dist`` exists the same process serves the built SPA. This is
  the production deployment shape: one container, one port.
"""

from __future__ import annotations

import csv
import hmac
import io
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from threading import Lock
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import data as market_data
from . import fixed_income, importer, instruments, lab, macro_sec, options, store
from .config import SETTINGS, Settings
from .observability import METRICS
from .portfolio import API_VERSION, AnalyticsUnavailable, PortfolioAnalytics, build_analytics
from .schemas import (
    AlertRuleIn,
    AttributionRequest,
    BaseCurrencyUpdate,
    BlackScholesInput,
    BlackScholesOutput,
    BondCalculatorInput,
    BondCalculatorOutput,
    CashFlowIn,
    CsvImportCommitRequest,
    CsvImportPreviewRequest,
    HistoricalYieldPoint,
    HoldingInput,
    HoldingOut,
    MacroHistoryPoint,
    MacroSummaryResponse,
    OptionChainResponse,
    OrderInput,
    PortfolioIn,
    RealizedPnlSummaryOut,
    SecFilingsResponse,
    StressRequest,
    TransactionOut,
    WatchlistItemIn,
    WhatIfRequest,
    YieldCurveSnapshot,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

STARTED_AT = uuid.uuid4().hex[:8]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Create the database and seed the demo portfolio exactly once."""
    try:
        store.init_db(SETTINGS)
        imported = store.seed_from_demo(SETTINGS)
        if imported:
            logger.info("Imported %d demo positions", imported)
    except Exception:  # noqa: BLE001 - never prevent the API from starting
        logger.exception("Database initialisation failed; the API will report the error")
    yield


app = FastAPI(
    title="Portfolio Analytics API",
    version=API_VERSION,
    summary="Risk, performance and Monte Carlo analytics for a multi-asset portfolio.",
    description=(
        "A single-user portfolio analytics service. Positions are stored in SQLite; "
        "market data comes from Yahoo Finance and is cached on disk."
    ),
    lifespan=lifespan,
)

# NOTE: the CORS middleware is registered at the very bottom of this module, on
# purpose. Starlette runs user middleware in reverse registration order, so the
# last one registered is the outermost. CORS must be outermost, otherwise a
# middleware that answers early - the API-key guard below - returns a response
# that never passes through CORSMiddleware, and the browser reports a bare
# "CORS error" instead of the 401 the server actually sent.


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


def error_response(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    detail: dict[str, Any] = {"code": code, "message": message}
    detail.update(extra)
    return JSONResponse(status_code=status, content={"detail": detail})


@app.exception_handler(store.EmptyPortfolio)
async def empty_portfolio_handler(_: Request, exc: store.EmptyPortfolio) -> JSONResponse:
    return error_response(
        409,
        "empty_portfolio",
        "The portfolio has no positions. Add one to compute analytics.",
    )


@app.exception_handler(store.HoldingNotFound)
async def not_found_handler(_: Request, exc: store.HoldingNotFound) -> JSONResponse:
    return error_response(404, "holding_not_found", str(exc))


@app.exception_handler(store.CashFlowNotFound)
async def cash_flow_not_found_handler(_: Request, exc: store.CashFlowNotFound) -> JSONResponse:
    return error_response(404, "cash_flow_not_found", str(exc))


@app.exception_handler(store.DuplicateTicker)
async def duplicate_handler(_: Request, exc: store.DuplicateTicker) -> JSONResponse:
    return error_response(409, "duplicate_ticker", str(exc))


@app.exception_handler(store.StoreError)
async def store_error_handler(_: Request, exc: store.StoreError) -> JSONResponse:
    logger.warning("Storage error: %s", exc)
    return error_response(500, "storage_error", str(exc))


@app.exception_handler(AnalyticsUnavailable)
async def analytics_unavailable_handler(_: Request, exc: AnalyticsUnavailable) -> JSONResponse:
    return error_response(503, "analytics_unavailable", str(exc))


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields = [
        {
            "field": ".".join(str(part) for part in item.get("loc", ()) if part not in {"body", "query"}),
            "message": item.get("msg", "invalid value"),
        }
        for item in exc.errors()
    ]
    message = fields[0]["message"] if fields else "The request is invalid."
    return error_response(422, "validation_error", message, fields=fields)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        return JSONResponse(status_code=exc.status_code, content={"detail": detail})
    return error_response(exc.status_code, "http_error", str(detail))


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Attach a request ID and conservative security headers to every response."""
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    return response


PUBLIC_PATHS = {
    "/health",
    "/api/v1/health",
    "/openapi.json",
    "/docs",
    "/docs/oauth2-redirect",
    "/redoc",
}
PUBLIC_PREFIXES = ("/assets/", "/favicon", "/snapshot.json")


@app.middleware("http")
async def api_key_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Require ``X-API-Key`` on data routes when a key is configured.

    The built SPA itself remains public: it contains no data. Every route that
    returns portfolio figures, or mutates positions, is protected.
    """
    if not SETTINGS.requires_api_key:
        return await call_next(request)

    path = request.url.path
    protected = (
        path.startswith("/api/")
        or path == "/holdings"
        or path.startswith("/portfolio")
        or path == "/refresh"
    ) and not path.startswith("/api/v1/health")
    protected = protected and path not in PUBLIC_PATHS and not path.startswith(PUBLIC_PREFIXES)
    if protected:
        supplied = request.headers.get("X-API-Key", "")
        if not hmac.compare_digest(supplied, SETTINGS.api_key):
            return error_response(401, "unauthorized", "A valid X-API-Key header is required.")
    return await call_next(request)


@app.middleware("http")
async def request_metrics(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Time every API request and count it by status and method.

    Registered after the API-key guard, so rejected requests are counted too,
    and before CORS, which handles preflights itself. The path is inspected to
    decide whether to record, but is not stored: the registry has no per-route
    labels and therefore no unbounded cardinality and no data to leak.
    """
    if not request.url.path.startswith("/api/"):
        return await call_next(request)

    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        METRICS.observe(
            request.method,
            status,
            (time.perf_counter() - started) * 1000.0,
        )


# CORS is registered last so that it wraps the API-key guard: the browser must
# be able to read the 401 body (and the 409/422 bodies raised further down)
# instead of seeing an opaque "CORS error".
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.cors_origins),
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


# ---------------------------------------------------------------------------
# Analytics cache
# ---------------------------------------------------------------------------


class AnalyticsService:
    """Revision-aware cache around :class:`PortfolioAnalytics`.

    Building analytics downloads prices and runs the Monte Carlo. We rebuild
    only when the stored positions or the reporting currency change. The lock
    serialises construction so ten simultaneous first requests do not start ten
    downloads.

    One instance caches one portfolio at a time. The cache key includes the
    portfolio id, so switching portfolios rebuilds rather than serving the
    previous portfolio's numbers.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = Lock()
        self._analytics: PortfolioAnalytics | None = None
        self._key: tuple[Any, ...] | None = None

    def _current_key(self, portfolio_id: int) -> tuple[Any, ...]:
        portfolio = store.build_portfolio(self.settings, portfolio_id)
        return (
            portfolio_id,
            store.revision(self.settings),
            portfolio.base_currency,
            self.settings.benchmark,
            self.settings.cache_dir,
            self.settings.history_years,
        )

    def get(
        self,
        *,
        force: bool = False,
        refresh_prices: bool = False,
        portfolio_id: int = store.DEFAULT_PORTFOLIO_ID,
    ) -> PortfolioAnalytics:
        key = self._current_key(portfolio_id)
        with self._lock:
            if not force and self._analytics is not None and self._key == key:
                METRICS.cache_hit()
                return self._analytics
            METRICS.cache_miss()
            portfolio = store.build_portfolio(self.settings, portfolio_id)
            logger.info(
                "Building analytics for %d positions in portfolio %d "
                "(force=%s, refresh_prices=%s)",
                len(portfolio.holdings),
                portfolio_id,
                force,
                refresh_prices,
            )
            analytics = build_analytics(
                self.settings,
                use_cache=not refresh_prices,
                portfolio=portfolio,
            )
            self._analytics = analytics
            self._key = key
            METRICS.cache_build()
            logger.info("Analytics ready as of %s", analytics.as_of)
            return analytics

    def invalidate(self) -> None:
        with self._lock:
            self._analytics = None
            self._key = None
            METRICS.cache_invalidation()


_service = AnalyticsService(SETTINGS)


def get_analytics(*, refresh_prices: bool = False) -> PortfolioAnalytics:
    """Compatibility helper used by tests and scripts."""
    return _service.get(refresh_prices=refresh_prices)


def _payload(name: str, portfolio_id: int = store.DEFAULT_PORTFOLIO_ID) -> dict[str, Any]:
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return getattr(analytics, name)()
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 - upstream failure boundary
        logger.exception("Failed to build %s", name)
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


def _portfolio_id(request: Request) -> int:
    """The portfolio a request is about.

    Selected with the ``X-Portfolio-Id`` header, or a ``portfolio`` query
    parameter for links that cannot carry a header. An unknown or malformed
    value falls back to the default portfolio rather than failing the
    request: a stale bookmark should not break the dashboard.
    """
    raw = request.headers.get("X-Portfolio-Id") or request.query_params.get("portfolio")
    try:
        portfolio_id = int(raw) if raw else store.DEFAULT_PORTFOLIO_ID
    except (TypeError, ValueError):
        portfolio_id = store.DEFAULT_PORTFOLIO_ID
    return portfolio_id if portfolio_id > 0 else store.DEFAULT_PORTFOLIO_ID


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------


def _settings_payload() -> dict[str, Any]:
    return {
        "benchmark": SETTINGS.benchmark,
        "benchmark_name": SETTINGS.benchmark_name,
        "benchmark_includes_dividends": SETTINGS.benchmark_includes_dividends,
        "risk_free_rate": SETTINGS.risk_free_rate,
        "history_years": SETTINGS.history_years,
        "trading_days_per_year": SETTINGS.trading_days_per_year,
        "api_key_required": SETTINGS.requires_api_key,
        "seed_demo": SETTINGS.seed_demo,
    }


@app.get("/api/v1/health", tags=["meta"])
def health_live(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Fast liveness probe. Does not download prices or require the API key."""
    return {
        "status": "ok",
        "version": API_VERSION,
        "process": STARTED_AT,
        "base_currency": store.get_base_currency(SETTINGS, portfolio_id),
        "positions": len(store.list_holdings(SETTINGS, portfolio_id)),
        "api_key_required": SETTINGS.requires_api_key,
    }


@app.get("/api/v1/metrics", tags=["meta"])
def metrics_snapshot() -> JSONResponse:
    """Operational counters for this process, as JSON.

    Request totals and latencies cover API traffic only; the analytics cache
    counters explain why a request was fast or slow. Nothing here identifies a
    client, a route or a portfolio — see ``observability.py`` for what is
    deliberately not recorded. The endpoint sits behind the same API key as the
    data routes when one is configured.
    """
    payload = {"version": API_VERSION, "process": STARTED_AT, **METRICS.snapshot()}
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/api/v1/bootstrap", tags=["meta"])
def bootstrap(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Everything the UI needs on first paint: settings, positions, analytics.

    Returns ``analytics: null`` for an empty portfolio instead of a 409 so the
    client can render an empty state with an editor, not an error page.
    """
    positions = store.list_holdings(SETTINGS, portfolio_id)
    analytics_payload: dict[str, Any] | None = None
    warnings: list[str] = []
    error: str | None = None

    if positions:
        try:
            payloads = _service.get(portfolio_id=portfolio_id).all_payloads()
            analytics_payload = {
                "health": payloads["/health"],
                "holdings": payloads["/holdings"],
                "summary": payloads["/portfolio/summary"],
                "history": payloads["/portfolio/history"],
                "returns": payloads["/portfolio/returns"],
                "risk": payloads["/portfolio/risk"],
                "montecarlo": payloads["/portfolio/montecarlo"],
            }
            warnings = payloads["/health"].get("warnings", [])
        except (store.EmptyPortfolio, AnalyticsUnavailable) as exc:
            # Positions exist but market data could not be loaded. Keep the
            # editor usable and explain the failure rather than returning 503
            # for the whole application shell.
            error = str(exc)
            warnings = [f"Analytics are temporarily unavailable: {exc}"]

    return {
        "api_version": API_VERSION,
        "source": "api",
        "base_currency": store.get_base_currency(SETTINGS, portfolio_id),
        "positions": positions,
        "portfolio_id": portfolio_id,
        "portfolios": store.list_portfolios(SETTINGS),
        "cash_flows": store.list_cash_flows(SETTINGS, portfolio_id),
        "analytics": analytics_payload,
        "warnings": warnings,
        "error": error,
        "settings": _settings_payload(),
    }


@app.post("/api/v1/portfolio/refresh", tags=["meta"])
def refresh(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Refetch prices and rebuild every analytic. Always hits the network."""
    analytics = _service.get(force=True, refresh_prices=True, portfolio_id=portfolio_id)
    return {
        "status": "refreshed",
        "as_of": analytics.as_of,
        "prices_fetched_at": analytics.market.fetched_at.isoformat(timespec="seconds"),
        "revision": store.revision(SETTINGS),
    }


# ---------------------------------------------------------------------------
# Analytics payloads
# ---------------------------------------------------------------------------


@app.get("/api/v1/portfolio/summary", tags=["analytics"])
def summary(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("summary", portfolio_id)


@app.get("/api/v1/portfolio/history", tags=["analytics"])
def history(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("history", portfolio_id)


@app.get("/api/v1/portfolio/returns", tags=["analytics"])
def returns(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("returns", portfolio_id)


@app.get("/api/v1/portfolio/risk", tags=["analytics"])
def risk(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("risk", portfolio_id)


@app.get("/api/v1/portfolio/montecarlo", tags=["analytics"])
def montecarlo(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("montecarlo", portfolio_id)


@app.get("/api/v1/holdings", tags=["analytics"])
def priced_holdings(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    return _payload("holdings", portfolio_id)


# ---------------------------------------------------------------------------
# Position CRUD
# ---------------------------------------------------------------------------


@app.get("/api/v1/positions", response_model=list[HoldingOut], tags=["positions"])
def list_positions(portfolio_id: int = Depends(_portfolio_id)) -> list[dict[str, Any]]:
    return store.list_holdings(SETTINGS, portfolio_id)

@app.post("/api/v1/positions", status_code=201, tags=["positions"])
def create_position(
    body: HoldingInput, portfolio_id: int = Depends(_portfolio_id)
) -> dict[str, Any]:
    created = store.create_holding(body.as_store_payload(), SETTINGS, portfolio_id)
    _service.invalidate()
    return created


@app.put("/api/v1/positions/{holding_id}", tags=["positions"])
def update_position(
    holding_id: int,
    body: HoldingInput,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    updated = store.update_holding(holding_id, body.as_store_payload(), SETTINGS, portfolio_id)
    _service.invalidate()
    return updated


@app.delete("/api/v1/positions/{holding_id}", status_code=204, tags=["positions"])
def delete_position(
    holding_id: int,
    response: Response,
    portfolio_id: int = Depends(_portfolio_id),
) -> Response:
    store.delete_holding(holding_id, SETTINGS, portfolio_id)
    _service.invalidate()
    response.status_code = 204
    return response


@app.get("/api/v1/instruments/{ticker}", tags=["positions"])
def instrument(ticker: str) -> dict[str, Any]:
    try:
        found = instruments.lookup(ticker)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_ticker", "message": str(exc)}) from exc
    except instruments.InstrumentError as exc:
        raise HTTPException(status_code=404, detail={"code": "instrument_not_found", "message": str(exc)}) from exc
    return {
        "ticker": found.ticker,
        "name": found.name,
        "currency": found.currency,
        "asset_class": found.asset_class,
        "region": found.region,
        "last_price": found.last_price,
        "as_of": found.as_of,
        "estimated": found.estimated,
    }


@app.put("/api/v1/settings/base-currency", tags=["settings"])
def update_base_currency(
    body: BaseCurrencyUpdate, portfolio_id: int = Depends(_portfolio_id)
) -> dict[str, Any]:
    try:
        code = store.set_base_currency(body.base_currency, SETTINGS, portfolio_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_currency", "message": str(exc)},
        ) from exc
    _service.invalidate()
    return {"base_currency": code}


# ---------------------------------------------------------------------------
# Portfolios
# ---------------------------------------------------------------------------


@app.get("/api/v1/portfolios", tags=["portfolios"])
def list_portfolios() -> list[dict[str, Any]]:
    """Every tracked portfolio. The active one is chosen per request with the
    ``X-Portfolio-Id`` header."""
    return store.list_portfolios(SETTINGS)


@app.post("/api/v1/portfolios", status_code=201, tags=["portfolios"])
def create_portfolio(body: PortfolioIn) -> dict[str, Any]:
    """Create an empty portfolio with its own reporting currency."""
    try:
        return store.create_portfolio(body.name, body.base_currency, SETTINGS)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_currency", "message": str(exc)},
        ) from exc


@app.delete("/api/v1/portfolios/{portfolio_id}", status_code=204, tags=["portfolios"])
def delete_portfolio(portfolio_id: int, response: Response) -> Response:
    """Delete a portfolio and everything in it.

    The default portfolio cannot be deleted: it is what the application falls
    back to, and removing it would leave the service with nowhere to put
    positions.
    """
    if portfolio_id == store.DEFAULT_PORTFOLIO_ID:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "default_portfolio",
                "message": "The default portfolio cannot be deleted.",
            },
        )
    store.delete_portfolio(portfolio_id, SETTINGS)
    _service.invalidate()
    response.status_code = 204
    return response


# ---------------------------------------------------------------------------
# Cash flows
# ---------------------------------------------------------------------------


@app.get("/api/v1/cash-flows", tags=["cash-flows"])
def list_cash_flows(portfolio_id: int = Depends(_portfolio_id)) -> list[dict[str, Any]]:
    """Every recorded contribution and withdrawal, oldest first."""
    return store.list_cash_flows(SETTINGS, portfolio_id)


@app.post("/api/v1/cash-flows", status_code=201, tags=["cash-flows"])
def create_cash_flow(
    body: CashFlowIn, portfolio_id: int = Depends(_portfolio_id)
) -> dict[str, Any]:
    """Record an external contribution (positive) or withdrawal (negative).

    Recorded flows are authoritative: once the ledger has any entry, the
    analytics use it instead of estimating contributions from the dates the
    positions were acquired.
    """
    created = store.create_cash_flow(
        {
            "occurred_on": body.occurred_on.isoformat(),
            "amount": body.amount,
            "note": body.note,
        },
        SETTINGS,
        portfolio_id,
    )
    _service.invalidate()
    return created


@app.delete("/api/v1/cash-flows/{cash_flow_id}", status_code=204, tags=["cash-flows"])
def delete_cash_flow(
    cash_flow_id: int,
    response: Response,
    portfolio_id: int = Depends(_portfolio_id),
) -> Response:
    store.delete_cash_flow(cash_flow_id, SETTINGS, portfolio_id)
    _service.invalidate()
    response.status_code = 204
    return response


# ---------------------------------------------------------------------------
# Orders & FIFO Transactions
# ---------------------------------------------------------------------------


@app.get("/api/v1/transactions", response_model=list[TransactionOut], tags=["transactions"])
def list_transactions(portfolio_id: int = Depends(_portfolio_id)) -> list[dict[str, Any]]:
    """Every executed Buy and Sell trade for the portfolio, newest first."""
    return store.list_transactions(SETTINGS, portfolio_id)


@app.post("/api/v1/orders", status_code=201, response_model=TransactionOut, tags=["transactions"])
def place_order(
    body: OrderInput, portfolio_id: int = Depends(_portfolio_id)
) -> dict[str, Any]:
    """Execute a Buy or Sell order with FIFO lot matching and update portfolio positions."""
    try:
        created = store.place_order(
            {
                "ticker": body.ticker,
                "order_type": body.order_type,
                "quantity": body.quantity,
                "price": body.price,
                "executed_at": body.executed_at.isoformat(),
                "notes": body.notes,
            },
            SETTINGS,
            portfolio_id,
        )
        _service.invalidate()
        return created
    except store.OrderValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "order_validation_error", "message": str(exc)},
        ) from exc


@app.delete("/api/v1/transactions/{transaction_id}", status_code=204, tags=["transactions"])
def delete_transaction(
    transaction_id: int,
    response: Response,
    portfolio_id: int = Depends(_portfolio_id),
) -> Response:
    try:
        store.delete_transaction(transaction_id, SETTINGS, portfolio_id)
        _service.invalidate()
        response.status_code = 204
        return response
    except store.TransactionNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc


@app.get("/api/v1/portfolio/realized-pnl", response_model=RealizedPnlSummaryOut, tags=["transactions"])
def get_realized_pnl(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Summary of realized gains, win rate and trade statistics."""
    return store.get_realized_pnl_summary(SETTINGS, portfolio_id)


# ---------------------------------------------------------------------------
# Fixed Income & Yield Curves
# ---------------------------------------------------------------------------


@app.get("/api/v1/fixed-income/yield-curve", response_model=YieldCurveSnapshot, tags=["fixed-income"])
def get_yield_curve(as_of: str | None = None) -> YieldCurveSnapshot:
    """Current US Treasury yield curve, comparative 1M/1Y curves, and key recession spreads."""
    service = fixed_income.get_fixed_income_service()
    return service.get_yield_curve(as_of)


@app.get("/api/v1/fixed-income/history", response_model=list[HistoricalYieldPoint], tags=["fixed-income"])
def get_historical_yields(range: str = "1Y") -> list[HistoricalYieldPoint]:
    """Historical time-series for 10Y, 2Y, 3M, 10Y-2Y spread, and corporate yields (AAA/BAA)."""
    service = fixed_income.get_fixed_income_service()
    return service.get_historical_series(range_key=range)


@app.post("/api/v1/fixed-income/calculator", response_model=BondCalculatorOutput, tags=["fixed-income"])
def calculate_bond(params: BondCalculatorInput) -> BondCalculatorOutput:
    """Bond pricing, Macaulay/Modified duration, convexity, DV01, and interest rate shock scenarios."""
    return fixed_income.FixedIncomeService.calculate_bond_metrics(params)


# ---------------------------------------------------------------------------
# Macroeconomic Intelligence & SEC EDGAR Filings
# ---------------------------------------------------------------------------


@app.get("/api/v1/sec/filings", response_model=SecFilingsResponse, tags=["sec"])
def get_sec_filings(
    ticker: str, form: str | None = None, limit: int = 50
) -> SecFilingsResponse:
    """Audited regulatory filings (10-K, 10-Q, 8-K) directly from SEC EDGAR."""
    service = macro_sec.get_macro_sec_service()
    return service.get_sec_filings(ticker=ticker, form_filter=form, limit=limit)


@app.get("/api/v1/macro/summary", response_model=MacroSummaryResponse, tags=["macro"])
def get_macro_summary() -> MacroSummaryResponse:
    """Federal Reserve, inflation, GDP, unemployment, and monetary macroeconomic indicators."""
    service = macro_sec.get_macro_sec_service()
    return service.get_macro_summary()


@app.get("/api/v1/macro/history", response_model=list[MacroHistoryPoint], tags=["macro"])
def get_macro_history(series: str = "CPIAUCSL", range: str = "5Y") -> list[MacroHistoryPoint]:
    """Historical time series for macroeconomic indicators."""
    service = macro_sec.get_macro_sec_service()
    return service.get_macro_history(series_id=series, range_key=range)


# ---------------------------------------------------------------------------
# Options Derivatives & Black-Scholes Greeks
# ---------------------------------------------------------------------------


@app.get("/api/v1/options/chain", response_model=OptionChainResponse, tags=["options"])
def get_option_chain(
    ticker: str, expiry: str | None = None
) -> OptionChainResponse:
    """Option chain with strikes, bid/ask, implied volatility, volume and open interest."""
    service = options.get_options_service()
    return service.get_option_chain(ticker=ticker, expiry=expiry)


@app.post("/api/v1/options/calculator", response_model=BlackScholesOutput, tags=["options"])
def calculate_option(params: BlackScholesInput) -> BlackScholesOutput:
    """Black-Scholes theoretical pricing, Greeks (Delta, Gamma, Vega, Theta, Rho), and payoff curve."""
    return options.calculate_black_scholes(params)


@app.post("/api/v1/portfolio/what-if", tags=["analytics"])
def what_if(
    body: WhatIfRequest,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Rebuild the analytics with a proposed set of target weights.

    The positions not mentioned keep their current weight. The result says
    what the risk would look like if the trades were made; it is not a
    forecast of what they would earn.
    """
    targets = {row.ticker: row.weight for row in body.targets}
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return analytics.what_if(targets)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_target", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 - upstream failure boundary
        logger.exception("Failed to build the what-if")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/portfolio/benchmark", tags=["analytics"])
def compare_benchmark(
    symbol: str,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Compare the portfolio against a benchmark other than the configured one.

    The comparison is computed on the portfolio's own sample, so the
    statistics are directly comparable with the configured benchmark.
    """
    cleaned = symbol.strip().upper()
    if not cleaned or len(cleaned) > 20:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_symbol", "message": "A benchmark symbol is required."},
        )
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return analytics.compare_with(cleaned)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_symbol", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 - upstream failure boundary
        logger.exception("Failed to compare with %s", cleaned)
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/portfolio/replay", tags=["analytics"])
def replay(
    start: str | None = None,
    end: str | None = None,
    notional: float = 100_000.0,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Run the current positions over a past window.

    A stress test of today's mix, not a reconstruction of what was held
    then: the current weights are applied to the prices of the period.
    """
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return analytics.replay(start=start, end=end, notional=notional)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_window", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001 - upstream failure boundary
        logger.exception("Failed to build the replay")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


# ---------------------------------------------------------------------------
# Portfolio Lab: Stress Testing, Brinson Attribution & Portfolio X-Ray
# ---------------------------------------------------------------------------


@app.get("/api/v1/portfolio/scenarios", tags=["lab"])
def list_scenarios() -> dict[str, Any]:
    """Catalogue of historical and parametric stress scenarios."""
    return {"scenarios": lab.scenario_catalogue()}


@app.get("/api/v1/portfolio/stress", tags=["lab"])
def get_stress(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Run all preset historical and parametric stress scenarios against the portfolio."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return lab.stress_report(analytics)
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build stress report")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.post("/api/v1/portfolio/stress", tags=["lab"])
def post_stress(
    body: StressRequest,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Run selected preset scenarios and/or a custom simultaneous factor shock."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        custom_shock = (
            lab.Shock(
                equity_pct=body.custom.equity_pct,
                rates_bps=body.custom.rates_bps,
                usd_pct=body.custom.usd_pct,
                gold_pct=body.custom.gold_pct,
                crypto_pct=body.custom.crypto_pct,
            )
            if body.custom is not None
            else None
        )
        return lab.stress_report(
            analytics,
            scenario_keys=body.scenarios,
            custom=custom_shock,
            durations=body.durations,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_stress_request", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to run custom stress scenario")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/portfolio/attribution", tags=["lab"])
def get_attribution(
    period: str = "all",
    group_by: str = "asset_class",
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Brinson-Fachler performance attribution (allocation, selection, interaction)."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return lab.attribution_report(analytics, period=period, group_by=group_by)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_attribution_request", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build attribution report")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.post("/api/v1/portfolio/attribution", tags=["lab"])
def post_attribution(
    body: AttributionRequest,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Brinson-Fachler performance attribution with optional custom policy benchmark."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        custom_bench = (
            [
                lab.BenchmarkSegment(
                    key=seg.key,
                    weight=seg.weight,
                    return_pct=seg.return_pct,
                    proxy=seg.proxy,
                )
                for seg in body.benchmark
            ]
            if body.benchmark is not None
            else None
        )
        return lab.attribution_report(
            analytics,
            period=body.period,
            group_by=body.group_by,
            benchmark=custom_bench,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_attribution_request", "message": str(exc)},
        ) from exc
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build custom attribution report")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/portfolio/xray", tags=["lab"])
def get_xray(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """One-screen Portfolio X-Ray: concentration, risk hogs, exposure & correlation clusters."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        return lab.xray_report(analytics)
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build portfolio X-Ray")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/portfolio/report", tags=["lab"])
def get_portfolio_report(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Compile a one-page institutional Factsheet & Investment Committee (IC) Memo."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
        portfolios = store.list_portfolios(SETTINGS)
        pname = next((p["name"] for p in portfolios if p["id"] == portfolio_id), "Primary Book")
        realized = store.get_realized_pnl_summary(SETTINGS, portfolio_id)
        return lab.factsheet_report(analytics, portfolio_name=pname, realized_summary=realized)
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build portfolio factsheet report")
        raise AnalyticsUnavailable(f"analytics unavailable: {exc}") from exc


@app.get("/api/v1/search", tags=["search"])
def unified_search(
    q: str = "",
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Unified Command Palette search across positions, portfolios, trades, scenarios, macro, and SEC."""
    query = q.strip().lower()
    positions = store.list_holdings(SETTINGS, portfolio_id)
    portfolios = store.list_portfolios(SETTINGS)
    transactions = store.list_transactions(SETTINGS, portfolio_id)
    scenarios = lab.scenario_catalogue()
    macro_items = macro_sec.get_macro_sec_service().get_macro_summary().indicators

    matched_positions = [
        p
        for p in positions
        if not query
        or query in p["ticker"].lower()
        or query in p["name"].lower()
        or query in (p.get("asset_class") or "").lower()
    ][:8]

    matched_portfolios = [
        p
        for p in portfolios
        if not query or query in p["name"].lower() or query in p["base_currency"].lower()
    ][:5]

    matched_trades = [
        t
        for t in transactions
        if not query
        or query in t["ticker"].lower()
        or query in t["order_type"].lower()
        or query in (t.get("notes") or "").lower()
    ][:5]

    matched_scenarios = [
        s
        for s in scenarios
        if not query
        or query in s["key"].lower()
        or query in s["name"].lower()
        or query in s["description"].lower()
    ][:5]

    matched_macro = [
        m.model_dump()
        for m in macro_items
        if not query
        or query in m.series_id.lower()
        or query in m.name.lower()
        or query in m.category.lower()
    ][:6]

    # Parse ticker-specific intent such as "NVDA 10-K", "AAPL options", or bare ticker "TSLA"
    tokens = [tok.upper() for tok in q.strip().split() if tok]
    candidate_ticker: str | None = None
    if tokens:
        first = tokens[0]
        if first in macro_sec.KNOWN_CIKS or (1 <= len(first) <= 6 and first.isalpha()):
            candidate_ticker = first

    return {
        "query": q,
        "candidate_ticker": candidate_ticker,
        "positions": matched_positions,
        "portfolios": matched_portfolios,
        "transactions": matched_trades,
        "scenarios": matched_scenarios,
        "macro": matched_macro,
    }


# ---------------------------------------------------------------------------
# CSV / Broker Statement Importer & Watchlists + Smart Alerts
# ---------------------------------------------------------------------------


@app.post("/api/v1/portfolio/import/preview", tags=["positions"])
def preview_import(
    body: CsvImportPreviewRequest,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Parse CSV text, auto-detect broker/ATLAS schema, and preview positions, trades & cash flows."""
    try:
        base_ccy = store.get_base_currency(SETTINGS, portfolio_id)
        return importer.preview_csv_import(
            body.csv_text,
            mapping_overrides=body.mapping_overrides,
            default_currency=base_ccy,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_csv", "message": str(exc)},
        ) from exc


@app.post("/api/v1/portfolio/import/commit", tags=["positions"])
def commit_import(
    body: CsvImportCommitRequest,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Commit parsed CSV positions, trades, and cash flows into the active portfolio."""
    try:
        result = importer.commit_csv_import(
            body.csv_text,
            mode=body.mode,
            mapping_overrides=body.mapping_overrides,
            settings=SETTINGS,
            portfolio_id=portfolio_id,
        )
        _service.invalidate()
        return result
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_csv", "message": str(exc)},
        ) from exc


@app.get("/api/v1/watchlist", tags=["watchlist"])
def get_watchlist(portfolio_id: int = Depends(_portfolio_id)) -> dict[str, Any]:
    """Return enriched watchlist items, custom alert rules, and live triggered smart alerts."""
    try:
        analytics = _service.get(portfolio_id=portfolio_id)
    except Exception:  # noqa: BLE001
        analytics = None
    return importer.get_watchlist_and_alerts(
        settings=SETTINGS,
        portfolio_id=portfolio_id,
        analytics=analytics,
    )


@app.post("/api/v1/watchlist", status_code=201, tags=["watchlist"])
def add_watchlist_item(
    body: WatchlistItemIn,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Add or update an instrument on the portfolio watchlist with target buy/sell prices."""
    try:
        return store.upsert_watchlist_item(
            body.model_dump(),
            settings=SETTINGS,
            portfolio_id=portfolio_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_watchlist_item", "message": str(exc)},
        ) from exc


@app.delete("/api/v1/watchlist/{item_id}", status_code=204, tags=["watchlist"])
def remove_watchlist_item(
    item_id: int,
    response: Response,
    portfolio_id: int = Depends(_portfolio_id),
) -> Response:
    store.delete_watchlist_item(item_id, settings=SETTINGS, portfolio_id=portfolio_id)
    response.status_code = 204
    return response


@app.post("/api/v1/alerts/rules", status_code=201, tags=["watchlist"])
def add_alert_rule(
    body: AlertRuleIn,
    portfolio_id: int = Depends(_portfolio_id),
) -> dict[str, Any]:
    """Create a custom price, drawdown, or risk alert rule."""
    try:
        return store.create_alert_rule(
            body.model_dump(),
            settings=SETTINGS,
            portfolio_id=portfolio_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_alert_rule", "message": str(exc)},
        ) from exc


@app.delete("/api/v1/alerts/rules/{rule_id}", status_code=204, tags=["watchlist"])
def remove_alert_rule(
    rule_id: int,
    response: Response,
    portfolio_id: int = Depends(_portfolio_id),
) -> Response:
    store.delete_alert_rule(rule_id, settings=SETTINGS, portfolio_id=portfolio_id)
    response.status_code = 204
    return response


@app.get("/api/v1/portfolio/export", tags=["positions"])
def export_portfolio(
    format: str = "json", portfolio_id: int = Depends(_portfolio_id)
) -> Response:
    """Download the stored positions and cash flows.

    JSON is lossless; CSV suits a spreadsheet. The CSV carries one row per
    position, followed by one row per cash flow, with a ``kind`` column so the
    two can be told apart.
    """
    rows = store.export_rows(SETTINGS, portfolio_id)
    flows = store.list_cash_flows(SETTINGS, portfolio_id)
    base_currency = store.get_base_currency(SETTINGS, portfolio_id)
    if format not in {"json", "csv"}:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_format", "message": "format must be 'json' or 'csv'"},
        )

    if format == "json":
        body = {
            "base_currency": base_currency,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "holdings": rows,
            "cash_flows": flows,
        }
        return JSONResponse(
            body,
            headers={"Content-Disposition": 'attachment; filename="portfolio.json"'},
        )

    # One table, one header, one `kind` column: positions and cash flows can
    # live in the same file and still be told apart on import.
    fields = [
        "kind", "ticker", "name", "asset_class", "region", "currency",
        "quantity", "cost_basis_per_unit", "acquired", "date", "amount", "note",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({**row, "kind": "position"})
    for flow in flows:
        writer.writerow(
            {
                "kind": "cash_flow",
                "date": flow["occurred_on"],
                "amount": flow["amount"],
                "note": flow["note"],
            }
        )
    return PlainTextResponse(
        buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="portfolio.csv"'},
    )


# ---------------------------------------------------------------------------
# Legacy aliases (pre-v1 clients and the committed snapshot)
# ---------------------------------------------------------------------------


@app.get("/health", tags=["legacy"], include_in_schema=False)
def legacy_health() -> dict[str, Any]:
    try:
        return _payload("health")
    except (store.EmptyPortfolio, AnalyticsUnavailable):
        return {
            "status": "empty",
            "version": API_VERSION,
            "as_of": None,
            "base_currency": store.get_base_currency(SETTINGS),
            "holdings_count": 0,
            "warnings": ["The portfolio has no positions."],
        }


@app.get("/holdings", tags=["legacy"], include_in_schema=False)
def legacy_holdings() -> dict[str, Any]:
    return _payload("holdings")


@app.get("/portfolio/summary", tags=["legacy"], include_in_schema=False)
def legacy_summary() -> dict[str, Any]:
    return _payload("summary")


@app.get("/portfolio/history", tags=["legacy"], include_in_schema=False)
def legacy_history() -> dict[str, Any]:
    return _payload("history")


@app.get("/portfolio/returns", tags=["legacy"], include_in_schema=False)
def legacy_returns() -> dict[str, Any]:
    return _payload("returns")


@app.get("/portfolio/risk", tags=["legacy"], include_in_schema=False)
def legacy_risk() -> dict[str, Any]:
    return _payload("risk")


@app.get("/portfolio/montecarlo", tags=["legacy"], include_in_schema=False)
def legacy_montecarlo() -> dict[str, Any]:
    return _payload("montecarlo")


@app.post("/refresh", tags=["legacy"], include_in_schema=False)
def legacy_refresh() -> dict[str, Any]:
    return refresh()


# ---------------------------------------------------------------------------
# Static SPA
# ---------------------------------------------------------------------------


def _frontend_dist() -> Any:
    return SETTINGS.frontend_dist


if _frontend_dist().exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(_frontend_dist() / "assets")),
        name="assets",
    )


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str) -> Response:
    """Serve the built dashboard, falling back to index.html for client routes.

    The route is declared after every API route, so it can never shadow them.
    """
    dist = _frontend_dist()
    if full_path.startswith(("api/", "docs", "openapi.json", "redoc")):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown route."})

    if not dist.exists():
        raise HTTPException(
            status_code=404,
            detail={
                "code": "frontend_not_built",
                "message": "frontend/dist is missing. Run `npm run build` in frontend/.",
            },
        )

    candidate = (dist / full_path).resolve()
    try:
        candidate.relative_to(dist.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown route."})
    if full_path and candidate.is_file():
        return FileResponse(candidate)

    index = dist / "index.html"
    if not index.exists():
        raise HTTPException(
            status_code=404,
            detail={"code": "frontend_not_built", "message": "frontend/dist/index.html is missing."},
        )
    return FileResponse(index)


__all__ = ["app", "get_analytics", "error_response"]
