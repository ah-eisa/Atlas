"""Market-data acquisition, caching, FX conversion and calendar alignment.

Responsibilities
----------------
1. Load the portfolio definition from ``holdings.json``.
2. Fetch ~2 years of daily closes for every holding, the benchmark and the
   EUR/USD rate from Yahoo Finance, caching the result on disk.
3. Convert USD-denominated instruments into the base currency (EUR).
4. Align the crypto (7-day) and equity (5-day) calendars onto a single
   trading-day index.

FX handling
-----------
Any base currency is supported, and holdings may be quoted in any number of
currencies. Yahoo Finance names a pair ``{FROM}{TO}=X``, quoted as *TO per 1
FROM*, so converting an instrument priced in ``C`` into base ``B`` needs the
series ``{C}{B}=X`` and a multiplication: ``price_B = price_C * rate``.

The full daily FX series is applied across the whole history, not just today,
so the equity curve reflects both asset performance and currency movement —
the honest view for an investor reporting in ``B``. Cost bases are converted at
the rate observed on the acquisition date, not today's, so unrealised P&L
includes the currency effect.

Some venues quote in a minor unit: London lists in ``GBp`` (pence), not pounds.
Those are normalised to the major unit before conversion, otherwise every UK
holding would be overstated by 100x.

Calendar alignment
------------------
Crypto trades 7 days a week, listed equities do not. Mixing the two naively
either inflates the observation count (breaking the ``sqrt(252)`` annualisation
convention) or injects artificial zero-return days. We therefore take the
benchmark's trading calendar (NYSE via ``^GSPC``) as the master index, drop
crypto observations on non-trading days, and forward-fill instrument prices
across venue-specific holidays (e.g. Euronext closed while NYSE is open). Every
series then has exactly one observation per trading day.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Sequence

import pandas as pd
import yfinance as yf

from .config import SETTINGS, Settings

logger = logging.getLogger(__name__)

# Bumped whenever the on-disk shape changes. A cache from an older version is
# ignored and replaced rather than migrated.
CACHE_FORMAT_VERSION = 5

# Venues that quote in a minor unit, mapped to their major unit and the factor
# that converts to it. Yahoo reports these codes verbatim in its metadata.
MINOR_UNITS: dict[str, tuple[str, float]] = {
    "GBp": ("GBP", 0.01),  # London: pence
    "ZAc": ("ZAR", 0.01),  # Johannesburg: cents
    "ILA": ("ILS", 0.01),  # Tel Aviv: agorot
}


def normalise_currency(code: str) -> tuple[str, float]:
    """Resolve a quote currency to its major unit and a scaling factor.

    Returns:
        ``(major_code, factor)`` such that ``price_major = price_quoted *
        factor``. Unrecognised codes pass through unchanged with a factor of 1.
    """
    major, factor = MINOR_UNITS.get(code, (code, 1.0))
    return major, factor


def fx_symbol(from_currency: str, to_currency: str) -> str:
    """Yahoo Finance symbol for a currency pair, quoted as *to* per 1 *from*."""
    return f"{from_currency}{to_currency}=X"


@dataclass(frozen=True)
class Holding:
    """One position in the portfolio.

    Attributes:
        ticker: yfinance symbol.
        name: Human-readable instrument name.
        asset_class: ``ETF`` | ``Stock`` | ``Crypto``.
        region: Geographic bucket, or ``None`` for region-less assets (crypto).
        currency: Currency the instrument is quoted in (``EUR`` or ``USD``).
        quantity: Units held. Frozen in ``holdings.json``; fractional allowed.
        cost_basis_per_unit: Entry price per unit, in ``currency``.
        acquired: ISO date of the (notional) purchase, used to pick the FX rate
            applied to the cost basis.
        target_weight: Optional target weight as a fraction of the portfolio
            (0.17 for 17%). Used to report allocation drift.
    """

    ticker: str
    name: str
    asset_class: str
    region: str | None
    currency: str
    quantity: float
    cost_basis_per_unit: float
    acquired: str
    target_weight: float | None = None

    @property
    def region_label(self) -> str:
        """Region for grouping; crypto has no meaningful geography."""
        return self.region or "Crypto"


@dataclass(frozen=True)
class CashFlow:
    """An external contribution to, or withdrawal from, the portfolio.

    Attributes:
        occurred_on: ISO date the money moved.
        amount: Signed amount in the base currency. Positive is money in,
            negative is money out.
        note: Free-text description, for the user's own bookkeeping.
    """

    occurred_on: str
    amount: float
    note: str = ""


@dataclass(frozen=True)
class Portfolio:
    """The portfolio definition as loaded from ``holdings.json``."""

    base_currency: str
    holdings: tuple[Holding, ...]
    cash_flows: tuple[CashFlow, ...] = ()

    @property
    def tickers(self) -> tuple[str, ...]:
        return tuple(h.ticker for h in self.holdings)

    def by_ticker(self, ticker: str) -> Holding:
        for holding in self.holdings:
            if holding.ticker == ticker:
                return holding
        raise KeyError(ticker)


@dataclass(frozen=True)
class MarketData:
    """Aligned market data in both native and base currency.

    Attributes:
        prices_native: Daily closes as quoted by the exchange, one column per
            holding ticker, indexed by trading day.
        prices_base: The same closes converted to the base currency.
        fx: Per-currency conversion series, keyed by the instrument's quote
            currency and giving *base units per 1 unit of that currency*. The
            base currency itself maps to a constant 1.0.
        benchmark: Benchmark daily close (only returns are ever used, so its
            own currency does not matter).
        base_currency: Reporting currency these frames are denominated in.
        fetched_at: UTC timestamp of the underlying download.
    """

    prices_native: pd.DataFrame
    prices_base: pd.DataFrame
    fx: dict[str, pd.Series]
    benchmark: pd.Series
    base_currency: str
    fetched_at: datetime
    # Last date on which the exchange actually printed a close, before the
    # trading-calendar forward fill. Used to surface stale quotes rather than
    # silently presenting a filled price as current.
    raw_last_dates: dict[str, date] = field(default_factory=dict)
    # True when the prices are older than the cache allows because the
    # provider could not be reached. The analytics are still computed, and
    # the UI says plainly how old they are.
    stale: bool = False

    @property
    def as_of(self) -> date:
        """Date of the most recent observation."""
        return self.prices_base.index[-1].date()

    def rate_series(self, currency: str) -> pd.Series:
        """Conversion series for ``currency``, in base units per unit.

        Raises:
            KeyError: if the currency was not part of the loaded portfolio.
        """
        major, _ = normalise_currency(currency)
        if major == self.base_currency:
            return pd.Series(1.0, index=self.prices_base.index)
        return self.fx[major]


def load_portfolio(path: Path | None = None) -> Portfolio:
    """Read and validate ``holdings.json``.

    Raises:
        ValueError: if the file is malformed or a holding is missing a field.
    """
    path = path or SETTINGS.holdings_path
    raw = json.loads(Path(path).read_text(encoding="utf-8"))

    if "holdings" not in raw:
        raise ValueError(f"{path}: missing 'holdings' array")

    holdings: list[Holding] = []
    for index, item in enumerate(raw["holdings"]):
        try:
            holdings.append(
                Holding(
                    ticker=str(item["ticker"]),
                    name=str(item["name"]),
                    asset_class=str(item["asset_class"]),
                    region=item.get("region") or None,
                    currency=str(item["currency"]),
                    quantity=float(item["quantity"]),
                    cost_basis_per_unit=float(item["cost_basis_per_unit"]),
                    acquired=str(item["acquired"]),
                    target_weight=(
                        float(item["target_weight"])
                        if item.get("target_weight") is not None
                        else None
                    ),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{path}: holding #{index} is invalid: {exc}") from exc

    if not holdings:
        raise ValueError(f"{path}: portfolio is empty")

    counts = Counter(h.ticker for h in holdings)
    duplicates = sorted(t for t, n in counts.items() if n > 1)
    if duplicates:
        raise ValueError(f"{path}: duplicate tickers {duplicates}")

    # Cash flows are optional. When present they replace the estimated flows
    # derived from position acquisition dates.
    cash_flows: list[CashFlow] = []
    for index, item in enumerate(raw.get("cash_flows", []) or []):
        try:
            cash_flows.append(
                CashFlow(
                    occurred_on=str(item["date"]),
                    amount=float(item["amount"]),
                    note=str(item.get("note", "")),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{path}: cash flow #{index} is invalid: {exc}") from exc

    return Portfolio(
        base_currency=str(raw.get("base_currency", "EUR")),
        holdings=tuple(holdings),
        cash_flows=tuple(cash_flows),
    )


def _cache_file(cache_dir: Path, symbols: Sequence[str], years: int) -> Path:
    """Deterministic cache path for a given symbol set and lookback."""
    key = f"v{CACHE_FORMAT_VERSION}-{years}y-{'_'.join(sorted(symbols))}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return cache_dir / f"prices-{years}y-{digest}.json"


def _download_closes(symbols: Sequence[str], start: date, end: date) -> pd.DataFrame:
    """Download adjusted daily closes for ``symbols`` from Yahoo Finance.

    A batch download is attempted twice before individual symbols are retried
    one by one. Yahoo's endpoint occasionally drops one ticker from an otherwise
    successful multi-symbol response; retrying the batch alone would convert
    that transient miss into a hard failure for the whole portfolio.

    Returns:
        DataFrame of closes indexed by date with one column per symbol.

    Raises:
        RuntimeError: if the download returns nothing usable.
    """
    logger.info("Downloading %d symbols from Yahoo Finance (%s .. %s)", len(symbols), start, end)

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            closes = _download_batch(symbols, start, end)
            missing = [s for s in symbols if s not in closes.columns or closes[s].dropna().empty]
            if not missing:
                return closes
            logger.warning("Batch download missed %s; retrying individually", missing)
            pieces = {s: closes[s] for s in symbols if s in closes.columns and closes[s].notna().any()}
            for symbol in missing:
                try:
                    single = _download_batch([symbol], start, end)
                    if symbol in single.columns and single[symbol].notna().any():
                        pieces[symbol] = single[symbol]
                except Exception as exc:  # noqa: BLE001 - keep the symbols that worked
                    last_error = exc
                    logger.warning("Individual download failed for %s: %s", symbol, exc)
            if len(pieces) == len(symbols):
                frame = pd.DataFrame(pieces).sort_index()
                frame.index.name = "date"
                return frame
            absent = [s for s in symbols if s not in pieces]
            raise RuntimeError(f"No price data returned for: {absent}")
        except RuntimeError:
            raise
        except Exception as exc:  # noqa: BLE001 - retry transport failures once
            last_error = exc
            logger.warning("Yahoo download attempt %d failed: %s", attempt + 1, exc)
            if attempt == 0:
                time.sleep(0.8)

    raise RuntimeError(f"Yahoo Finance download failed: {last_error}") from last_error


def _download_batch(symbols: Sequence[str], start: date, end: date) -> pd.DataFrame:
    raw = yf.download(
        list(symbols),
        start=start.isoformat(),
        end=end.isoformat(),
        auto_adjust=True,
        progress=False,
        group_by="column",
        threads=True,
    )
    if raw is None or raw.empty:
        raise RuntimeError("Yahoo Finance returned no data; check connectivity or symbols")

    closes = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw[["Close"]]
    if isinstance(closes, pd.Series):  # single-symbol edge case
        closes = closes.to_frame(symbols[0])
    if len(symbols) == 1 and list(closes.columns) == ["Close"]:
        closes = closes.rename(columns={"Close": symbols[0]})

    closes.index = pd.to_datetime(closes.index).tz_localize(None).normalize()
    closes.index.name = "date"
    return closes.sort_index()


def _read_cache(path: Path) -> tuple[pd.DataFrame, datetime] | None:
    """Read the cached closes, whatever their age.

    The cache is plain JSON rather than a pickle: it lives in a user-writable
    directory, and unpickling an attacker-controlled file executes arbitrary
    code. Nothing in a price cache justifies that risk.
    """
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        frame = pd.read_json(io.StringIO(json.dumps(payload["closes"])), orient="split")
        frame.index = pd.to_datetime(frame.index).tz_localize(None).normalize()
        frame.index.name = "date"
        frame = frame.sort_index()
        if frame.empty:
            raise ValueError("cache contains no rows")
        fetched_at = datetime.fromisoformat(payload["fetched_at"])
        return frame, fetched_at
    except Exception as exc:  # noqa: BLE001 - a corrupt cache must never be fatal
        logger.warning("Ignoring unreadable price cache %s: %s", path, exc)
        return None


def _load_cached(path: Path, ttl_hours: float) -> tuple[pd.DataFrame, datetime] | None:
    """Return cached closes if the cache exists and is fresh, else ``None``."""
    if not path.exists():
        return None
    age_hours = (time.time() - path.stat().st_mtime) / 3600.0
    if age_hours > ttl_hours:
        logger.info("Price cache is %.1fh old (ttl %.1fh); refetching", age_hours, ttl_hours)
        return None
    return _read_cache(path)


def _store_cache(path: Path, closes: pd.DataFrame, fetched_at: datetime) -> None:
    """Write the cache atomically so a crash cannot leave a truncated file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "format": CACHE_FORMAT_VERSION,
        "fetched_at": fetched_at.isoformat(),
        "closes": json.loads(closes.to_json(orient="split", date_format="iso")),
    }
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def _align_to_trading_calendar(closes: pd.DataFrame, benchmark_symbol: str) -> pd.DataFrame:
    """Project every series onto the benchmark's trading calendar.

    Crypto rows falling on non-trading days are dropped; instrument-specific
    gaps (foreign exchange holidays) are forward-filled from the last close.
    Leading rows that are still incomplete after the fill are removed so that
    no metric is computed against a partially-populated portfolio.
    """
    calendar = closes[benchmark_symbol].dropna().index
    aligned = closes.reindex(calendar).ffill()
    return aligned.dropna(how="any")


def load_symbol_series(
    symbol: str,
    start: date,
    end: date,
    settings: Settings = SETTINGS,
) -> pd.Series:
    """Download one symbol's daily closes, with its own cache.

    Used for comparing the portfolio against a benchmark other than the
    configured one. The cache is keyed on the symbol and the window, so
    switching back and forth between benchmarks costs one download each.
    """
    cache_path = settings.cache_dir / (
        f"series-v{CACHE_FORMAT_VERSION}-{symbol.replace('^', '').replace('=', '-')}"
        f"-{start.isoformat()}-{end.isoformat()}.json"
    )
    cached = _load_cached(cache_path, settings.cache_ttl_hours)
    if cached is not None:
        frame, _ = cached
    else:
        frame = _download_batch([symbol], start, end)
        _store_cache(cache_path, frame, datetime.now(timezone.utc))

    if symbol not in frame.columns:
        raise ValueError(f"no price data returned for {symbol}")
    series = frame[symbol].dropna()
    series.index = pd.to_datetime(series.index).tz_localize(None).normalize()
    series.index.name = "date"
    if series.empty:
        raise ValueError(f"no price data returned for {symbol}")
    return series.sort_index()


def load_market_data(
    portfolio: Portfolio,
    settings: Settings = SETTINGS,
    *,
    use_cache: bool = True,
) -> MarketData:
    """Fetch, cache, align and FX-convert all price history the app needs.

    Args:
        portfolio: Portfolio whose tickers should be fetched.
        settings: Runtime settings (lookback, benchmark, FX pair, cache).
        use_cache: When ``False``, always hit the network.

    Returns:
        A :class:`MarketData` with native and base-currency price frames.
    """
    if not portfolio.holdings:
        raise ValueError("portfolio has no holdings")

    base = portfolio.base_currency

    # One FX series per foreign quote currency in the portfolio.
    foreign = sorted(
        {
            normalise_currency(holding.currency)[0]
            for holding in portfolio.holdings
            if normalise_currency(holding.currency)[0] != base
        }
    )
    pairs = {currency: fx_symbol(currency, base) for currency in foreign}

    symbols = list(dict.fromkeys([*portfolio.tickers, settings.benchmark, *pairs.values()]))
    end = date.today() + timedelta(days=1)  # yfinance `end` is exclusive
    start = end - timedelta(days=int(365.25 * settings.history_years) + 10)

    cache_path = _cache_file(settings.cache_dir, symbols, settings.history_years)
    cached = _load_cached(cache_path, settings.cache_ttl_hours) if use_cache else None
    stale = False

    if cached is not None:
        closes, fetched_at = cached
        logger.info("Using cached prices from %s", fetched_at.isoformat())
    else:
        try:
            closes = _download_closes(symbols, start, end)
            fetched_at = datetime.now(timezone.utc)
            _store_cache(cache_path, closes, fetched_at)
        except Exception as exc:  # noqa: BLE001 - the fallback is the point
            # The provider is unreachable. The last known prices are still
            # worth more than an error page: the analytics are computed from
            # them and the UI is told how old they are.
            fallback = _read_cache(cache_path)
            if fallback is None:
                raise
            closes, fetched_at = fallback
            stale = True
            logger.warning(
                "Yahoo Finance is unreachable (%s); falling back to prices from %s",
                exc,
                fetched_at.isoformat(),
            )

    # Record the last genuine print per symbol before gaps are forward-filled,
    # so the UI can distinguish "market closed" from "this feed stopped".
    raw_last_dates = {
        symbol: pd.Timestamp(series.dropna().index[-1]).date()
        for symbol, series in closes.items()
        if series.notna().any()
    }

    aligned = _align_to_trading_calendar(closes, settings.benchmark)

    fx = {currency: aligned[symbol] for currency, symbol in pairs.items()}
    benchmark = aligned[settings.benchmark]
    prices_native = aligned.loc[:, list(portfolio.tickers)]

    prices_base = prices_native.copy()
    for holding in portfolio.holdings:
        currency, unit = normalise_currency(holding.currency)
        if currency == base:
            # Still applies the minor-unit factor: GBp priced against a GBP base.
            prices_base[holding.ticker] = prices_native[holding.ticker] * unit
        else:
            prices_base[holding.ticker] = prices_native[holding.ticker] * unit * fx[currency]

    return MarketData(
        prices_native=prices_native,
        prices_base=prices_base,
        fx=fx,
        benchmark=benchmark,
        base_currency=base,
        fetched_at=fetched_at,
        raw_last_dates=raw_last_dates,
        stale=stale,
    )


def fx_rate_on(fx: pd.Series, day: str | date) -> float:
    """FX rate on ``day``, or the most recent rate before it.

    Used to convert a cost basis at its acquisition-date rate rather than
    today's, so unrealised P&L correctly includes the currency effect.
    """
    stamp = pd.Timestamp(day).normalize()
    window = fx.loc[:stamp]
    if window.empty:
        return float(fx.iloc[0])
    return float(window.iloc[-1])


def to_iso_dates(index: Iterable[pd.Timestamp]) -> list[str]:
    """Format a datetime index as ``YYYY-MM-DD`` strings for JSON output."""
    return [pd.Timestamp(ts).strftime("%Y-%m-%d") for ts in index]
