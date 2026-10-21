"""Best-effort instrument metadata for the portfolio editor.

The editor should not require the user to know a ticker's quote currency or
asset class. Yahoo exposes both, but its metadata endpoint is slow and
occasionally unavailable, so the lookup is cached and every missing field has a
conservative fallback that is explicitly flagged as estimated.

This module never makes up a price. If no recent close exists, ``last_price`` is
``None`` and the caller can ask the user to enter the cost basis manually.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import date

import yfinance as yf

logger = logging.getLogger(__name__)

_TICKER_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")
_CACHE_TTL_SECONDS = 3600.0
_cache: dict[str, tuple[float, "Instrument"]] = {}
_lock = threading.Lock()

_QUOTE_TYPE_TO_CLASS = {
    "EQUITY": "Stock",
    "ETF": "ETF",
    "MUTUALFUND": "Fund",
    "CRYPTOCURRENCY": "Crypto",
    "INDEX": "Index",
    "CURRENCY": "Cash",
    "BOND": "Bond",
}

_SUFFIX_CURRENCY = {
    ".AS": "EUR",
    ".DE": "EUR",
    ".PA": "EUR",
    ".MI": "EUR",
    ".MC": "EUR",
    ".SW": "CHF",
    ".L": "GBp",
    ".TO": "CAD",
    ".V": "CAD",
    ".T": "JPY",
    ".AX": "AUD",
    ".HK": "HKD",
    ".SI": "SGD",
}

_SUFFIX_REGION = {
    ".AS": "Europe",
    ".DE": "Europe",
    ".PA": "Europe",
    ".MI": "Europe",
    ".MC": "Europe",
    ".SW": "Europe",
    ".L": "Europe",
    ".TO": "US",
    ".V": "US",
    ".T": "Asia",
    ".AX": "Asia",
    ".HK": "China",
    ".SI": "Asia",
}

_COUNTRY_TO_REGION = {
    "United States": "US",
    "Canada": "US",
    "Germany": "Europe",
    "Netherlands": "Europe",
    "France": "Europe",
    "Switzerland": "Europe",
    "United Kingdom": "Europe",
    "Ireland": "Europe",
    "Italy": "Europe",
    "Spain": "Europe",
    "Sweden": "Europe",
    "China": "China",
    "Hong Kong": "China",
    "Taiwan": "Asia",
    "Japan": "Asia",
    "South Korea": "Asia",
    "India": "Asia",
    "Australia": "Asia",
    "Singapore": "Asia",
    "Brazil": "Americas",
    "Mexico": "Americas",
}


class InstrumentError(Exception):
    """The ticker could not be resolved to a tradable instrument."""


@dataclass(frozen=True)
class Instrument:
    ticker: str
    name: str
    currency: str
    asset_class: str
    region: str | None
    last_price: float | None
    as_of: str | None
    estimated: bool


def _fallback_currency(ticker: str) -> tuple[str, bool]:
    for suffix, currency in _SUFFIX_CURRENCY.items():
        if ticker.upper().endswith(suffix):
            return currency, True
    if ticker.upper().endswith("-USD") or ticker.upper().endswith("-EUR"):
        return "USD", True
    return "USD", True


def _fallback_region(ticker: str) -> str | None:
    for suffix, region in _SUFFIX_REGION.items():
        if ticker.upper().endswith(suffix):
            return region
    return None


def lookup(raw_ticker: str) -> Instrument:
    """Resolve a ticker, with a one-hour in-process cache.

    Raises:
        ValueError: for a syntactically invalid symbol.
        InstrumentError: when Yahoo has no recent price for the symbol.
    """
    ticker = raw_ticker.strip().upper()
    if not _TICKER_RE.match(ticker):
        raise ValueError("invalid ticker symbol")

    now = time.monotonic()
    with _lock:
        cached = _cache.get(ticker)
        if cached is not None and now - cached[0] < _CACHE_TTL_SECONDS:
            return cached[1]

    instrument = _fetch(ticker)
    with _lock:
        _cache[ticker] = (now, instrument)
    return instrument


def _fetch(ticker: str) -> Instrument:
    handle = yf.Ticker(ticker)
    history = None
    try:
        history = handle.history(period="5d", auto_adjust=True)
    except Exception as exc:  # noqa: BLE001 - provider failure is an expected path
        logger.warning("Price lookup failed for %s: %s", ticker, exc)

    if history is None or history.empty:
        raise InstrumentError(f"no recent price data for {ticker}")

    closes = history["Close"].dropna()
    if closes.empty:
        raise InstrumentError(f"no recent close for {ticker}")
    last_price = float(closes.iloc[-1])
    as_of = str(closes.index[-1].date())

    name = ticker
    currency = ""
    quote_type = ""
    country = ""
    try:
        info = handle.info or {}
        name = str(info.get("longName") or info.get("shortName") or ticker)
        currency = str(info.get("currency") or "")
        quote_type = str(info.get("quoteType") or "")
        country = str(info.get("country") or "")
    except Exception as exc:  # noqa: BLE001 - metadata is optional
        logger.info("Metadata unavailable for %s: %s", ticker, exc)

    estimated = False
    if not currency:
        currency, _ = _fallback_currency(ticker)
        estimated = True
    if not quote_type:
        estimated = True

    asset_class = _QUOTE_TYPE_TO_CLASS.get(quote_type.upper(), "Stock")
    if ticker.endswith("-USD") and asset_class == "Stock":
        asset_class = "Crypto"
    region = _COUNTRY_TO_REGION.get(country) or _fallback_region(ticker)
    if asset_class == "Crypto":
        region = None

    return Instrument(
        ticker=ticker,
        name=name,
        currency=currency,
        asset_class=asset_class,
        region=region,
        last_price=last_price,
        as_of=as_of,
        estimated=estimated,
    )


def clear_cache() -> None:
    with _lock:
        _cache.clear()
