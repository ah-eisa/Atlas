"""Request/response schemas and the validation boundary for the HTTP API.

All user input crosses this module before it reaches the store or the analytics
engine. Validation is intentionally strict: a typo in a ticker or a negative
quantity should produce a field-level 422, not a silently wrong valuation.
"""

from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TICKER_PATTERN = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")
CURRENCY_PATTERN = re.compile(r"^[A-Za-z]{3}$")

AssetClass = Literal["Stock", "ETF", "Fund", "Crypto", "Bond", "Cash", "Other"]
ASSET_CLASSES: tuple[str, ...] = ("Stock", "ETF", "Fund", "Crypto", "Bond", "Cash", "Other")
ASSET_CLASS_LOOKUP = {value.lower(): value for value in ASSET_CLASSES}
MINOR_CURRENCIES = {"GBp", "ZAc", "ILA"}


class HoldingInput(BaseModel):
    """One current position, as submitted by the portfolio editor."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    ticker: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=120)
    asset_class: str = Field(default="Stock", max_length=20)
    region: str | None = Field(default=None, max_length=40)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    quantity: float = Field(gt=0, le=1e12, allow_inf_nan=False)
    cost_basis_per_unit: float = Field(ge=0, le=1e15, allow_inf_nan=False)
    acquired: date
    target_weight: float | None = Field(
        default=None,
        ge=0,
        le=1,
        allow_inf_nan=False,
        description="Optional target weight as a fraction of the portfolio (0.17 = 17%).",
    )

    @field_validator("ticker")
    @classmethod
    def _ticker(cls, value: str) -> str:
        normalised = value.strip().upper()
        if not TICKER_PATTERN.match(normalised):
            raise ValueError(
                "ticker must be a Yahoo Finance symbol (letters, digits, '.', '-', '=' or a leading '^')"
            )
        return normalised

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name cannot be blank")
        return value.strip()

    @field_validator("asset_class")
    @classmethod
    def _asset_class(cls, value: str) -> str:
        canonical = ASSET_CLASS_LOOKUP.get(value.strip().lower())
        if canonical is None:
            raise ValueError(f"asset_class must be one of {', '.join(ASSET_CLASSES)}")
        return canonical

    @field_validator("region")
    @classmethod
    def _region(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("currency")
    @classmethod
    def _currency(cls, value: str) -> str:
        cleaned = value.strip()
        if not CURRENCY_PATTERN.match(cleaned):
            raise ValueError("currency must be a three-letter ISO code")
        if cleaned in MINOR_CURRENCIES:
            return cleaned
        return cleaned.upper()

    @field_validator("acquired")
    @classmethod
    def _acquired(cls, value: date) -> date:
        if value > date.today():
            raise ValueError("acquisition date cannot be in the future")
        if value < date(1970, 1, 1):
            raise ValueError("acquisition date is too far in the past")
        return value

    def as_store_payload(self) -> dict[str, Any]:
        return {
            "ticker": self.ticker,
            "name": self.name,
            "asset_class": self.asset_class,
            "region": self.region,
            "currency": self.currency,
            "quantity": self.quantity,
            "cost_basis_per_unit": self.cost_basis_per_unit,
            "acquired": self.acquired.isoformat(),
            "target_weight": self.target_weight,
        }


class HoldingOut(BaseModel):
    id: int
    ticker: str
    name: str
    asset_class: str
    region: str | None
    currency: str
    quantity: float
    cost_basis_per_unit: float
    acquired: date
    target_weight: float | None = None
    created_at: str
    updated_at: str


class BaseCurrencyUpdate(BaseModel):
    base_currency: str = Field(min_length=3, max_length=3)

    @field_validator("base_currency")
    @classmethod
    def _code(cls, value: str) -> str:
        cleaned = value.strip().upper()
        if not CURRENCY_PATTERN.match(cleaned):
            raise ValueError("base currency must be a three-letter ISO code")
        return cleaned


class WhatIfTarget(BaseModel):
    """A proposed weight for one position."""

    ticker: str = Field(min_length=1, max_length=20)
    weight: float = Field(ge=0, le=1, allow_inf_nan=False)


class WhatIfRequest(BaseModel):
    """A proposed rebalance: the positions that should change, and to what."""

    targets: list[WhatIfTarget] = Field(default_factory=list, max_length=100)


class PortfolioIn(BaseModel):
    """A new portfolio."""

    name: str = Field(min_length=1, max_length=80)
    base_currency: str = Field(default="", max_length=3)


class CashFlowIn(BaseModel):
    """An external contribution to, or withdrawal from, the portfolio."""

    occurred_on: date
    amount: float = Field(
        description="Signed amount in the base currency: positive is money in."
    )
    note: str = Field(default="", max_length=200)


class InstrumentInfo(BaseModel):
    """Best-effort metadata for a ticker entered in the portfolio editor."""

    ticker: str
    name: str
    currency: str
    asset_class: str
    region: str | None
    last_price: float | None
    as_of: str | None
    estimated: bool = False


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    detail: ErrorDetail


OrderType = Literal["BUY", "SELL"]


class OrderInput(BaseModel):
    """Execution of a Buy or Sell order."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    ticker: str = Field(min_length=1, max_length=20)
    order_type: OrderType
    quantity: float = Field(gt=0, le=1e12, allow_inf_nan=False)
    price: float = Field(ge=0, le=1e15, allow_inf_nan=False)
    executed_at: date
    notes: str = Field(default="", max_length=200)

    @field_validator("ticker")
    @classmethod
    def _ticker(cls, value: str) -> str:
        normalised = value.strip().upper()
        if not TICKER_PATTERN.match(normalised):
            raise ValueError(
                "ticker must be a Yahoo Finance symbol (letters, digits, '.', '-', '=' or a leading '^')"
            )
        return normalised


class TransactionOut(BaseModel):
    id: int
    portfolio_id: int
    ticker: str
    order_type: OrderType
    quantity: float
    price: float
    realized_pnl: float
    executed_at: str
    notes: str
    created_at: str


class RealizedPnlSummaryOut(BaseModel):
    total_realized_pnl: float
    total_trades: int
    total_buys: int
    total_sells: int
    winning_trades: int
    losing_trades: int
    win_rate_pct: float | None
    total_buy_volume: float
    total_sell_volume: float


# --------------------------------------------------------------------------
# Fixed Income & Yield Curve Models
# --------------------------------------------------------------------------


class YieldPoint(BaseModel):
    tenor: str
    series_id: str
    years: float
    yield_pct: float


class YieldCurveSnapshot(BaseModel):
    as_of_date: str
    curve_points: list[YieldPoint]
    curve_points_1m_ago: list[YieldPoint] | None = None
    curve_points_1y_ago: list[YieldPoint] | None = None
    spread_10y_2y_bps: float
    spread_10y_3m_bps: float
    curve_status: str  # NORMAL, INVERTED, FLAT
    us10y_yield: float
    us2y_yield: float
    us3m_yield: float
    aaa_yield: float | None = None
    baa_yield: float | None = None
    credit_spread_baa_aaa_bps: float | None = None
    credit_spread_baa_10y_bps: float | None = None


class HistoricalYieldPoint(BaseModel):
    date: str
    dgs10: float | None = None
    dgs2: float | None = None
    dgs3mo: float | None = None
    t10y2y: float | None = None
    aaa: float | None = None
    baa: float | None = None


class BondCalculatorInput(BaseModel):
    face_value: float = Field(default=1000.0, gt=0, le=1e9)
    coupon_rate: float = Field(default=5.0, ge=0, le=100.0)
    ytm: float = Field(default=5.0, ge=0.001, le=100.0)
    years_to_maturity: float = Field(default=10.0, gt=0, le=100.0)
    frequency: int = Field(default=2, ge=1, le=12)


class RateShockScenario(BaseModel):
    shift_bps: int
    new_ytm: float
    repriced_bond: float
    price_change_dollars: float
    price_change_pct: float


class BondCalculatorOutput(BaseModel):
    price: float
    clean_price: float
    macaulay_duration: float
    modified_duration: float
    convexity: float
    dv01: float
    annual_coupon_income: float
    current_yield: float
    scenarios: list[RateShockScenario]


# --------------------------------------------------------------------------
# SEC EDGAR & Macroeconomic Models
# --------------------------------------------------------------------------


class SecFilingItem(BaseModel):
    form: str
    filing_date: str
    report_date: str | None = None
    accession_number: str
    primary_document: str
    description: str
    url: str
    is_xbrl: bool = False


class SecFilingsResponse(BaseModel):
    ticker: str
    cik: str
    company_name: str
    filings: list[SecFilingItem]


class MacroIndicator(BaseModel):
    series_id: str
    name: str
    category: str
    latest_value: float
    unit: str
    observation_date: str
    previous_value: float
    change: float
    change_pct: float


class MacroSummaryResponse(BaseModel):
    indicators: list[MacroIndicator]
    as_of: str


class MacroHistoryPoint(BaseModel):
    date: str
    value: float


# --------------------------------------------------------------------------
# Options & Black-Scholes Greeks Models
# --------------------------------------------------------------------------


class OptionContract(BaseModel):
    contract_symbol: str
    strike: float
    last_price: float
    bid: float | None = None
    ask: float | None = None
    volume: int = 0
    open_interest: int = 0
    implied_volatility: float
    in_the_money: bool
    delta: float | None = None
    gamma: float | None = None
    vega: float | None = None
    theta: float | None = None


class OptionChainResponse(BaseModel):
    ticker: str
    underlying_price: float
    expirations: list[str]
    selected_expiration: str
    calls: list[OptionContract]
    puts: list[OptionContract]
    # "sample" means the provider had no chain and every figure is synthetic.
    source: Literal["live", "sample"] = "live"


class BlackScholesInput(BaseModel):
    underlying_price: float = Field(default=100.0, gt=0, le=1e6)
    strike_price: float = Field(default=100.0, gt=0, le=1e6)
    dte: float = Field(default=30.0, gt=0, le=3650.0)
    volatility_pct: float = Field(default=25.0, gt=0, le=500.0)
    risk_free_rate_pct: float = Field(default=4.5, ge=0, le=100.0)
    dividend_yield_pct: float = Field(default=0.0, ge=0, le=100.0)


class OptionGreeks(BaseModel):
    delta: float
    gamma: float
    vega: float
    theta: float
    rho: float


class PayoffPoint(BaseModel):
    underlying_price: float
    call_payoff: float
    put_payoff: float


class BlackScholesOutput(BaseModel):
    call_price: float
    put_price: float
    call_greeks: OptionGreeks
    put_greeks: OptionGreeks
    call_intrinsic: float
    call_time_value: float
    put_intrinsic: float
    put_time_value: float
    payoff_curve: list[PayoffPoint]


# --------------------------------------------------------------------------
# Portfolio Lab (stress, attribution, X-Ray)
# --------------------------------------------------------------------------


class ShockIn(BaseModel):
    """Simultaneous market moves. ``*_pct`` fields are fractions (-0.15 = -15%)."""

    model_config = ConfigDict(extra="forbid")

    equity_pct: float = Field(default=0.0, ge=-0.95, le=2.0, allow_inf_nan=False)
    rates_bps: float = Field(default=0.0, ge=-1000.0, le=1000.0, allow_inf_nan=False)
    usd_pct: float = Field(default=0.0, ge=-0.5, le=1.0, allow_inf_nan=False)
    gold_pct: float = Field(default=0.0, ge=-0.9, le=3.0, allow_inf_nan=False)
    crypto_pct: float | None = Field(default=None, ge=-0.99, le=5.0, allow_inf_nan=False)


class StressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenarios: list[str] | None = None
    custom: ShockIn | None = None
    durations: dict[str, float] | None = None


class BenchmarkSegmentIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    key: str = Field(min_length=1, max_length=60)
    weight: float = Field(ge=0, le=1.0, allow_inf_nan=False)
    return_pct: float | None = Field(default=None, ge=-0.99, le=100.0, allow_inf_nan=False)
    proxy: str | None = Field(default=None, max_length=20)


class AttributionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period: Literal["day", "week", "month", "ytd", "all"] = "all"
    group_by: Literal["asset_class", "region", "currency"] = "asset_class"
    benchmark: list[BenchmarkSegmentIn] | None = None


# --------------------------------------------------------------------------
# CSV / Broker Importer & Watchlist / Smart Alerts Schemas
# --------------------------------------------------------------------------


class CsvImportPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    csv_text: str = Field(min_length=1, max_length=2_000_000)
    mapping_overrides: dict[str, str] | None = None


class CsvImportCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    csv_text: str = Field(min_length=1, max_length=2_000_000)
    mode: Literal["merge", "replace"] = "merge"
    mapping_overrides: dict[str, str] | None = None


class WatchlistItemIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    ticker: str = Field(min_length=1, max_length=20)
    name: str = Field(default="", max_length=120)
    target_buy_price: float | None = Field(default=None, ge=0, le=1e12, allow_inf_nan=False)
    target_sell_price: float | None = Field(default=None, ge=0, le=1e12, allow_inf_nan=False)
    notes: str = Field(default="", max_length=200)


class AlertRuleIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    metric: Literal[
        "price_above",
        "price_below",
        "drawdown_pct",
        "var_95_pct",
        "position_weight_pct",
        "yield_10y_above",
    ]
    ticker: str | None = Field(default=None, max_length=20)
    threshold: float = Field(ge=-1e12, le=1e12, allow_inf_nan=False)
    label: str = Field(default="", max_length=160)


class MarketQuote(BaseModel):
    symbol: str
    name: str
    price: str
    change: str
    pct: str
    isPositive: bool


class MarketTickerResponse(BaseModel):
    as_of: str
    quotes: list[MarketQuote]
    # "sample" means the provider was unreachable and the quotes are static.
    source: Literal["live", "sample"] = "live"


def is_finite(value: float) -> bool:
    return math.isfinite(value)
