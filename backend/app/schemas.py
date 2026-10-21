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


def is_finite(value: float) -> bool:
    return math.isfinite(value)
