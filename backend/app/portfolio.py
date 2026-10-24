"""Assembly layer: turns market data + metrics into the API payloads.

This is the only module that knows the shape of the JSON contract. ``metrics``
and ``montecarlo`` stay pure and unrounded; everything user-facing is composed,
rounded and made JSON-safe here, so the wire format can be changed without
touching any computation.

Performance methodology
-----------------------
Positions are *not* assumed to have existed for the full downloaded history.
Each holding becomes active on the first trading day on or after its
acquisition date. External contributions are the cost of each position on the
day it enters the portfolio (the app models one lot per ticker). Daily returns
are therefore time-weighted: ``r_t = (V_t - F_t) / V_{t-1} - 1``. This keeps a
deposit from being counted as investment performance and makes the drawdown and
risk figures describe the capital that was actually at risk.

The chart's ``portfolio`` series is the resulting growth index, scaled so its
last point equals today's market value. ``portfolio_value`` carries the actual
market value for users who want to see contribution jumps explicitly.

Unit conventions (mirrored in ``API.md``):

* Money is in the base currency, rounded to 2 dp.
* Every field whose name ends in ``_pct`` is a **fraction**: ``0.1234`` means
  12.34%. Ratios (Sharpe, Sortino, beta, correlation) are unitless, 4 dp.
* Dates are ISO ``YYYY-MM-DD`` strings.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from functools import cached_property
from typing import Any

import numpy as np
import pandas as pd

from . import ledger, metrics, montecarlo
from .config import SETTINGS, Settings
from .data import Holding, MarketData, Portfolio, fx_rate_on, normalise_currency, to_iso_dates
from .serialize import iso, json_safe, money_series, ratio_series, round_money, round_ratio

logger = logging.getLogger(__name__)

SPARKLINE_DAYS: int = 90
API_VERSION: str = "2.3.0"

PERIODS: tuple[metrics.PeriodKey, ...] = ("day", "week", "month", "ytd", "all")


class AnalyticsUnavailable(RuntimeError):
    """Raised when the loaded data cannot support the requested analytics."""


def _holding_lots(holding: Holding) -> list[tuple[str, float]]:
    """``(acquired, quantity)`` for each lot of a holding; one lot if it has none."""
    if holding.lots:
        return [(lot.acquired, lot.quantity) for lot in holding.lots]
    return [(holding.acquired, holding.quantity)]


@dataclass(frozen=True)
class PositionView:
    """A holding enriched with everything the UI needs about it."""

    ticker: str
    name: str
    asset_class: str
    region: str
    currency: str
    quantity: float
    price_native: float
    price_base: float
    value_base: float
    allocation_pct: float
    cost_basis_native: float
    cost_basis_base: float
    cost_total_base: float
    unrealized_pnl: float
    unrealized_pnl_pct: float
    day_change_pct: float
    acquired: str
    sparkline: list[float]
    # Attribution of the unrealised P&L between the two effects that can move
    # it: the instrument's own price, and the currency it is quoted in.
    price_effect: float | None
    fx_effect: float | None
    fx_rate_now: float
    fx_rate_at_acquisition: float
    price_native_at_acquisition: float | None
    target_weight: float | None
    drift: float | None


class PortfolioAnalytics:
    """Computes every published figure from a portfolio and its market data.

    Results that are expensive (the Monte Carlo simulation) or reused across
    endpoints are memoised with ``cached_property``, so constructing one
    instance per process is enough to serve all endpoints cheaply.
    """

    def __init__(
        self,
        portfolio: Portfolio,
        market: MarketData,
        settings: Settings = SETTINGS,
    ) -> None:
        if not portfolio.holdings:
            raise AnalyticsUnavailable("portfolio has no positions")
        missing = [ticker for ticker in portfolio.tickers if ticker not in market.prices_base.columns]
        if missing:
            raise AnalyticsUnavailable(f"no market data for {missing}")
        self.portfolio = portfolio
        self.market = market
        self.settings = settings

    # ------------------------------------------------------------------
    # The ledger
    # ------------------------------------------------------------------

    @cached_property
    def ledger_replay(self) -> ledger.Replay | None:
        """The ledger replayed, or ``None`` for a portfolio without one.

        A portfolio read from ``holdings.json`` has no ledger: its positions
        are all there is, and the analytics estimate how the money arrived.
        """
        if not self.portfolio.ledger:
            return None
        try:
            return ledger.replay(self.portfolio.ledger, self.portfolio.base_currency)
        except ledger.LedgerError as exc:
            logger.warning("The ledger does not replay (%s); using the positions alone", exc)
            return None

    @cached_property
    def ledger_tickers(self) -> frozenset[str]:
        """Positions whose history is rebuilt from the ledger.

        Every position the ledger describes exactly, and every position it
        closed that the market data can still price. A held position the
        ledger does not describe (it should not happen; the store records
        every hand edit) falls back to its own acquisition date.
        """
        replayed = self.ledger_replay
        if replayed is None:
            return frozenset()
        result: set[str] = set()
        held = set()
        for holding in self.portfolio.holdings:
            held.add(holding.ticker.upper())
            quantity, _, _ = replayed.position(holding.ticker.upper())
            if abs(quantity - holding.quantity) <= ledger.QTY_EPS * max(1.0, holding.quantity):
                result.add(holding.ticker)
        priced = set(self.market.prices_base.columns)
        for movement in replayed.movements:
            ticker = movement.ticker
            if ticker and movement.units and ticker not in held and ticker in priced:
                result.add(ticker)
        return frozenset(result)

    @cached_property
    def unpriced_tickers(self) -> list[str]:
        """Closed positions the market data has no history for."""
        replayed = self.ledger_replay
        if replayed is None:
            return []
        held = {holding.ticker.upper() for holding in self.portfolio.holdings}
        priced = set(self.market.prices_base.columns)
        return sorted(
            {
                m.ticker
                for m in replayed.movements
                if m.ticker and m.units and m.ticker not in held and m.ticker not in priced
            }
        )

    def _movement_applies(self, movement: ledger.Movement) -> bool:
        """Whether a movement is part of the history the analytics rebuild."""
        if movement.ticker is None:
            return True
        if movement.ticker in self.ledger_tickers:
            return True
        # Income and charges of a position still count when its units come
        # from its acquisition date rather than the ledger.
        return not movement.units and movement.kind not in ("BUY", "SELL") and (
            movement.ticker not in self.unpriced_tickers
        )

    # ------------------------------------------------------------------
    # Position schedule and valuation
    # ------------------------------------------------------------------

    @cached_property
    def quantity_frame(self) -> pd.DataFrame:
        """Units held per ticker on each trading day, in today's units.

        A position rebuilt from the ledger holds what its events say on each
        day: units bought later are not credited with returns that predate
        them, and units sold are part of the history until the day they were
        sold. The price history is adjusted for splits, so units before a
        split are restated in today's units with the split's ratio.

        A holding without a ledger is its lots (or a single lot on its
        acquisition date): the history describes the positions held today.
        """
        index = self.market.prices_base.index
        closed = sorted(self.ledger_tickers - set(self.portfolio.tickers))
        frame = pd.DataFrame(0.0, index=index, columns=[*self.portfolio.tickers, *closed])
        for holding in self.portfolio.holdings:
            if holding.ticker in self.ledger_tickers:
                continue
            column = frame.columns.get_loc(holding.ticker)
            for acquired, quantity in _holding_lots(holding):
                position = self._first_position(acquired)
                frame.iloc[position:, column] += quantity

        replayed = self.ledger_replay
        if replayed is not None:
            for movement in replayed.movements:
                if not movement.units or movement.ticker not in self.ledger_tickers:
                    continue
                column = frame.columns.get_loc(movement.ticker)
                frame.iloc[self._first_position(movement.on):, column] += movement.units
            for ticker, splits in replayed.splits.items():
                if ticker not in self.ledger_tickers:
                    continue
                column = frame.columns.get_loc(ticker)
                for on, ratio in splits:
                    frame.iloc[: self._first_position(on), column] *= ratio
        return frame.clip(lower=0.0)

    def _first_position(self, acquired: str) -> int:
        """Index of the first trading day on or after ``acquired``.

        A lot acquired after the last close (e.g. today, before the data
        provider publishes) is attached to the latest observation so it still
        appears in the priced portfolio.
        """
        index = self.market.prices_base.index
        target = pd.Timestamp(acquired).normalize()
        position = int(index.searchsorted(target, side="left"))
        return min(position, len(index) - 1)

    def _split_factor(self, ticker: str, position: int) -> float:
        """Today's units per unit held on the trading day at ``position``."""
        factor = 1.0
        if self.ledger_replay is not None:
            for on, ratio in self.ledger_replay.splits.get(ticker, []):
                if self._first_position(on) > position:
                    factor *= ratio
        return factor

    def _rate_at(self, currency: str, position: int) -> float:
        """Base units per unit of ``currency`` on the trading day at ``position``."""
        major, unit = normalise_currency(currency)
        if major == self.portfolio.base_currency:
            return unit
        series = self.market.fx.get(major)
        if series is None:
            return float("nan")
        return float(series.iloc[position]) * unit

    @cached_property
    def market_dividends(self) -> list[ledger.Movement]:
        """Dividends the market data says the positions were entitled to.

        For each ex-dividend date, the units held at the previous close times
        the dividend per unit, paid on the ex-date. Prices that already have
        dividends folded in (an older cache) produce none: the dividend is
        already in the price. A dividend the owner recorded - paid within 60
        days after the ex-date - replaces the derived one, because it is what
        was actually received, net of the tax withheld.
        """
        if self.market.dividends_in_prices or not self.market.dividends:
            return []
        recorded: dict[str, list[pd.Timestamp]] = {}
        if self.ledger_replay is not None:
            for movement in self.ledger_replay.movements:
                if movement.category == "dividend" and movement.ticker:
                    recorded.setdefault(movement.ticker, []).append(pd.Timestamp(movement.on))
        quantities = self.quantity_frame
        index = quantities.index
        result: list[ledger.Movement] = []
        for ticker, series in self.market.dividends.items():
            if ticker not in quantities.columns:
                continue
            currency = self._currency_of(ticker)
            for stamp, per_unit in series.items():
                if not per_unit or per_unit <= 0:
                    continue
                ex_date = pd.Timestamp(stamp).normalize()
                position = int(index.searchsorted(ex_date, side="left"))
                if position == 0 or position >= len(index):
                    continue
                units = float(quantities[ticker].iloc[position - 1])
                if units <= ledger.QTY_EPS:
                    continue
                if any(
                    pd.Timedelta(0) <= paid - ex_date <= pd.Timedelta(days=60)
                    for paid in recorded.get(ticker, [])
                ):
                    continue
                amount = units * float(per_unit)
                on = ex_date.strftime("%Y-%m-%d")
                result.append(
                    ledger.Movement(
                        on,
                        f"market:{ticker}:{on}",
                        "DIVIDEND",
                        ticker,
                        cash=((currency, amount),),
                        category="dividend",
                        value=amount,
                        currency=currency,
                    )
                )
        return result

    def _currency_of(self, ticker: str) -> str:
        for holding in self.portfolio.holdings:
            if holding.ticker == ticker:
                return holding.currency
        if self.ledger_replay is not None and ticker in self.ledger_replay.currencies:
            return self.ledger_replay.currencies[ticker]
        return self.portfolio.currencies.get(ticker, self.portfolio.base_currency)

    @cached_property
    def _cash_book(self) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
        """Cash per currency, the money the owner added, and what they withdrew.

        Returns ``(balances, implicit, external)`` over the full price index:
        ``balances`` in each currency's own units; ``implicit`` the money the
        owner is assumed to have added on a day, in the base currency;
        ``external`` the deposits and withdrawals they recorded.

        A purchase is paid from cash in its own currency first, then from
        base-currency cash converted at the day's rate. What cash cannot pay
        for is money the owner added - the assumption the analytics have
        always made about a purchase - and is an external flow on that day.
        Sale proceeds and dividends stay in the portfolio as cash until they
        are spent or withdrawn.
        """
        index = self.market.prices_base.index
        base = self.portfolio.base_currency
        days: list[dict[str, float]] = [defaultdict(float) for _ in range(len(index))]
        external = np.zeros(len(index))

        def credit(position: int, currency: str, amount: float) -> None:
            major, unit = normalise_currency(currency)
            days[position][major] += amount * unit

        if self.ledger_replay is None:
            return (
                pd.DataFrame(index=index, columns=[base], data=0.0),
                pd.Series(0.0, index=index),
                pd.Series(0.0, index=index),
            )

        prices = self.market.prices_base
        quantities = self.quantity_frame
        # A position the ledger does not describe arrives at its market value.
        for holding in self.portfolio.holdings:
            if holding.ticker in self.ledger_tickers:
                continue
            for acquired, quantity in _holding_lots(holding):
                position = self._first_position(acquired)
                credit(position, base, -float(prices[holding.ticker].iloc[position]) * quantity)
        for movement in [*self.ledger_replay.movements, *self.market_dividends]:
            if not self._movement_applies(movement):
                continue
            position = self._first_position(movement.on)
            if movement.at_market:
                if movement.ticker in quantities.columns:
                    # Units nobody recorded a price for (a hand-edited
                    # position) arrive at the day's market value.
                    units = movement.units * self._split_factor(movement.ticker, position)
                    credit(position, base, -units * float(prices[movement.ticker].iloc[position]))
                continue
            for currency, amount in movement.cash:
                if movement.kind == "DIVIDEND" and self.market.dividends_in_prices:
                    # The price already carries the dividend.
                    continue
                credit(position, currency, amount)
            if movement.category == "withholding" and self.market.dividends_in_prices:
                # ...but not the tax withheld from it.
                credit(position, movement.currency or base, -movement.value)
            external[position] += movement.external

        currencies = sorted({base, *(c for day in days for c in day)})
        balance = dict.fromkeys(currencies, 0.0)
        balances = np.zeros((len(index), len(currencies)))
        implicit = np.zeros(len(index))
        for position, deltas in enumerate(days):
            for currency, amount in deltas.items():
                balance[currency] += amount
            for currency in currencies:
                if currency != base and balance[currency] < -1e-9:
                    rate = self._rate_at(currency, position)
                    if np.isfinite(rate):
                        balance[base] += balance[currency] * rate
                        balance[currency] = 0.0
            if balance[base] < -1e-9:
                implicit[position] += -balance[base]
                balance[base] = 0.0
            balances[position] = [balance[currency] for currency in currencies]
        return (
            pd.DataFrame(balances, index=index, columns=currencies),
            pd.Series(implicit, index=index),
            pd.Series(external, index=index),
        )

    @cached_property
    def cash_balances(self) -> pd.DataFrame:
        """Cash per currency in its own units, over the active window."""
        balances, _, _ = self._cash_book
        return balances.loc[self.active_index]

    @cached_property
    def cash_frame(self) -> pd.DataFrame:
        """Cash per currency in the base currency, over the active window.

        Foreign cash is valued at each day's rate, so a currency's move on
        cash held in it is part of the portfolio's return.
        """
        balances = self.cash_balances
        frame = pd.DataFrame(0.0, index=balances.index, columns=balances.columns)
        for currency in balances.columns:
            major, unit = normalise_currency(currency)
            if major == self.portfolio.base_currency:
                frame[currency] = balances[currency] * unit
            elif major in self.market.fx:
                rates = self.market.fx[major].reindex(balances.index).ffill()
                frame[currency] = balances[currency] * rates * unit
        return frame.fillna(0.0)

    @cached_property
    def active_index(self) -> pd.DatetimeIndex:
        """Trading days from the first position (or the first cash) onward."""
        quantities = self.quantity_frame
        active = quantities.sum(axis=1) > 0
        if self.ledger_replay is not None:
            balances, _, _ = self._cash_book
            active = active | (balances.abs().sum(axis=1) > 1e-9)
        if not bool(active.any()):
            return self.market.prices_base.index[-1:]
        first = active.idxmax()
        return self.market.prices_base.loc[first:].index

    @cached_property
    def active_quantity_frame(self) -> pd.DataFrame:
        return self.quantity_frame.loc[self.active_index]

    @cached_property
    def prices_base(self) -> pd.DataFrame:
        return self.market.prices_base.loc[self.active_index, list(self.quantity_frame.columns)]

    @cached_property
    def position_values(self) -> pd.DataFrame:
        """Per-holding market value in the base currency, for every trading day."""
        return self.value_frame

    @cached_property
    def value_frame(self) -> pd.DataFrame:
        """Per-position market value through time, honouring when units were held."""
        return self.prices_base * self.active_quantity_frame

    @cached_property
    def equity(self) -> pd.Series:
        """Actual portfolio market value in the base currency, every trading day.

        Positions plus the cash the portfolio holds.
        """
        positions = metrics.equity_curve(self.value_frame)
        if self.ledger_replay is None:
            return positions
        return positions + self.cash_frame.sum(axis=1)

    @cached_property
    def flows(self) -> pd.Series:
        """External contributions, indexed by trading day.

        With a ledger, the flows are the deposits and withdrawals the owner
        recorded, plus the money they are assumed to have added whenever the
        portfolio's cash could not pay for a purchase (see ``_cash_book``).
        Dividends, fees, taxes, sales and conversions move money inside the
        portfolio, so they are part of its return, not flows.

        Without a ledger, recorded cash flows are authoritative when there
        are any; otherwise a position enters the portfolio at its *market
        value* on the first day it is held. That is the correct external flow
        for a time-weighted return: the purchase transfers wealth into the
        portfolio rather than creating it. Using the cost basis instead would
        report the difference between the entered cost and that day's close
        as investment performance.

        What is already there on the first observation is the opening value
        and produces no flow.
        """
        index = self.active_index
        result = pd.Series(0.0, index=index)
        if len(index) == 0:
            return result

        if self.ledger_replay is not None:
            _, implicit, external = self._cash_book
            result = (implicit + external).loc[index].astype(float)
            result.iloc[0] = 0.0
            return result

        ledger_flows = self.portfolio.cash_flows
        if ledger_flows:
            for flow in ledger_flows:
                target = pd.Timestamp(flow.occurred_on).normalize()
                position = int(index.searchsorted(target, side="left"))
                # A flow before the first observation is part of the opening
                # portfolio; a flow after the last one has not happened yet.
                if position == 0 or position >= len(index):
                    continue
                result.iloc[position] += flow.amount
            return result

        prices = self.prices_base
        for holding in self.portfolio.holdings:
            for acquired, quantity in _holding_lots(holding):
                target = pd.Timestamp(acquired).normalize()
                position = int(index.searchsorted(target, side="left"))
                position = min(position, len(index) - 1)
                # Only lots acquired inside the observed window are flows. At
                # position 0 the lot is part of the opening portfolio.
                if position == 0:
                    continue
                result.iloc[position] += float(prices[holding.ticker].iloc[position]) * quantity
        return result

    @property
    def flow_source(self) -> str:
        """Whether the flow series is recorded (``ledger``) or estimated."""
        return "ledger" if self.portfolio.cash_flows else "estimated"

    def money_weighted_return(self) -> float | None:
        """Annualised return on the money actually invested.

        The time-weighted return measures the portfolio's behaviour, and is
        the right number for judging the strategy. It is not the right
        number for judging the investor's experience: money that arrived
        late, or arrived in instalments, is weighted by how long it was
        there. This is the internal rate of return on the same cash flows,
        and the two together are the honest picture.

        Returns ``None`` when there is no solution - a portfolio that never
        turned a profit or a loss has no meaningful rate.
        """
        flows = [
            (pd.Timestamp(stamp), float(amount))
            for stamp, amount in self.flows.items()
            if amount
        ]
        if not flows:
            return None
        final_date = self.market.prices_base.index[-1]
        return metrics.money_weighted_return(flows, float(self.total_value), final_date)

    @cached_property
    def portfolio_returns(self) -> pd.Series:
        """Daily time-weighted returns, net of external contributions.

        Formula: ``r_t = (V_t - F_t) / V_{t-1} - 1``

        The first observation has no previous value and is dropped. A day on
        which the portfolio was empty (before the first purchase) is never part
        of the active index, so no artificial zero-return days are injected.
        """
        equity = self.equity.astype(float)
        flows = self.flows.reindex(equity.index).fillna(0.0)
        previous = equity.shift(1)
        returns = (equity - flows) / previous - 1.0
        returns = returns.where(previous > 0.0)
        returns.iloc[0] = np.nan
        return returns.dropna()

    @cached_property
    def growth_index(self) -> pd.Series:
        """Cumulative time-weighted growth, starting at 1.0."""
        returns = self.portfolio_returns
        if returns.empty:
            return pd.Series([1.0], index=self.active_index[-1:])
        index = returns.index
        values = (1.0 + returns).cumprod()
        # Prepend the baseline so the chart starts on the first observation.
        baseline = pd.Series([1.0], index=pd.DatetimeIndex([self.active_index[0]]))
        return pd.concat([baseline, values]).groupby(level=0).last()

    @cached_property
    def growth_value(self) -> pd.Series:
        """Growth index rescaled so the last point equals today's market value.

        This makes the performance line directly comparable with the headline
        value while preserving time-weighted percentage moves.
        """
        growth = self.growth_index
        final = float(growth.iloc[-1]) if len(growth) else 1.0
        total = float(self.equity.iloc[-1]) if len(self.equity) else 0.0
        scale = total / final if final else total
        return growth * scale

    @cached_property
    def asset_returns(self) -> pd.DataFrame:
        """Daily simple returns per holding over the full downloaded history.

        Used for covariance-dependent analytics (Monte Carlo, risk
        contribution). The longer sample is deliberate: a position acquired
        last week would otherwise make its covariance unknowable.
        """
        return metrics.daily_returns_frame(self.market.prices_base)

    @cached_property
    def benchmark_returns(self) -> pd.Series:
        """Benchmark daily returns aligned to the portfolio's active window."""
        benchmark = self.market.benchmark.reindex(self.active_index).ffill()
        return metrics.daily_returns(benchmark)

    @cached_property
    def total_value(self) -> float:
        return float(self.equity.iloc[-1])

    @cached_property
    def positions(self) -> list[PositionView]:
        """Every holding, priced and enriched as of the latest close."""
        latest_base = self.prices_base.iloc[-1]
        previous_base = self.prices_base.iloc[-2] if len(self.prices_base) > 1 else self.prices_base.iloc[-1]
        latest_native = self.market.prices_native.iloc[-1]
        current_values = self.value_frame.iloc[-1]
        # A weight is a share of everything the portfolio holds, cash included.
        total = float(self.total_value)
        weights = current_values / total if total else current_values * 0.0
        history_tail = self.prices_base.tail(SPARKLINE_DAYS)

        views: list[PositionView] = []
        for holding in self.portfolio.holdings:
            ticker = holding.ticker
            price_base = float(latest_base[ticker])

            # Cost basis is converted at the FX rate of the acquisition date, so
            # unrealised P&L includes the currency move since entry. The unit
            # factor handles venues quoting in a minor unit (London's pence).
            _, unit = normalise_currency(holding.currency)
            rate = fx_rate_on(self.market.rate_series(holding.currency), holding.acquired)
            cost_base = holding.cost_basis_per_unit * unit * rate

            pnl_abs, pnl_pct = metrics.unrealized_pnl(holding.quantity, price_base, cost_base)
            prev = float(previous_base[ticker])

            # Split the unrealised P&L into what the instrument did and what
            # the currency did.
            #
            #   price effect = q * (p_now - p_entry) * rate_entry
            #   fx effect    = q * p_now * (rate_now - rate_entry)
            #
            # The two add up exactly to the reported P&L, so the split is a
            # decomposition rather than an approximation. The price effect is
            # measured in the currency the position was bought in, which is
            # the only way to say "the stock moved" without the currency
            # contaminating the answer.
            price_native_now = float(latest_native[ticker])
            rate_now = (
                1.0
                if normalise_currency(holding.currency)[0] == self.portfolio.base_currency
                else fx_rate_on(self.market.rate_series(holding.currency), self.as_of)
            )
            price_entry = self._native_price_at(holding.ticker, holding.acquired)
            if price_entry is None:
                price_effect = fx_effect = None
            else:
                price_effect = holding.quantity * (price_native_now - price_entry) * rate
                fx_effect = holding.quantity * price_native_now * (rate_now - rate)

            views.append(
                PositionView(
                    ticker=ticker,
                    name=holding.name,
                    asset_class=holding.asset_class,
                    region=holding.region_label,
                    currency=holding.currency,
                    quantity=holding.quantity,
                    price_native=price_native_now,
                    price_base=price_base,
                    value_base=float(current_values[ticker]),
                    allocation_pct=float(weights[ticker]),
                    cost_basis_native=holding.cost_basis_per_unit,
                    cost_basis_base=float(cost_base),
                    cost_total_base=float(holding.quantity * cost_base),
                    unrealized_pnl=pnl_abs,
                    unrealized_pnl_pct=pnl_pct,
                    day_change_pct=(price_base / prev - 1.0) if prev else float("nan"),
                    acquired=holding.acquired,
                    sparkline=[float(v) for v in history_tail[ticker]],
                    price_effect=price_effect,
                    fx_effect=fx_effect,
                    fx_rate_now=rate_now,
                    fx_rate_at_acquisition=rate,
                    price_native_at_acquisition=price_entry,
                    target_weight=holding.target_weight,
                    drift=(
                        float(weights[ticker]) - holding.target_weight
                        if holding.target_weight is not None
                        else None
                    ),
                )
            )
        return views

    def _native_price_at(self, ticker: str, day: str) -> float | None:
        """The instrument's own-currency price on ``day``, or ``None``.

        Returns ``None`` when the position was acquired before the downloaded
        history starts: there is no entry price to compare against, so the
        price/currency split cannot be made and is reported as unknown rather
        than estimated.
        """
        series = self.market.prices_native[ticker].dropna()
        if series.empty:
            return None
        window = series.loc[: pd.Timestamp(day).normalize()]
        if window.empty:
            return None
        return float(window.iloc[-1])

    @cached_property
    def monte_carlo(self) -> montecarlo.MonteCarloResult:
        held = self.value_frame.iloc[-1].reindex(list(self.portfolio.tickers)).fillna(0.0)
        result = montecarlo.simulate(
            self.asset_returns[list(self.portfolio.tickers)],
            held,
            paths=self.settings.mc_paths,
            horizon_days=self.settings.mc_horizon_days,
            seed=self.settings.mc_seed,
            batch_paths=self.settings.mc_batch_paths,
            histogram_bins=self.settings.mc_histogram_bins,
            trading_days_per_year=self.settings.trading_days_per_year,
        )
        cash = sum(self.cash_values.values())
        if not cash:
            return result
        # Cash is held as it is: it shifts every outcome by the same amount.
        start = result.start_value + cash
        return replace(
            result,
            start_value=start,
            percentile_bands={
                key: [value + cash for value in values] for key, values in result.percentile_bands.items()
            },
            final_values_summary={key: value + cash for key, value in result.final_values_summary.items()},
            histogram=[
                replace(bucket, start=bucket.start + cash, end=bucket.end + cash)
                for bucket in result.histogram
            ],
            expected_value=result.expected_value + cash,
            median_value=result.median_value + cash,
            expected_return_pct=(result.expected_value + cash) / start - 1.0 if start else 0.0,
        )

    # ------------------------------------------------------------------
    # Shared fragments
    # ------------------------------------------------------------------

    @property
    def as_of(self) -> str:
        return self.market.as_of.isoformat()

    def _envelope(self) -> dict[str, Any]:
        return {
            "as_of": self.as_of,
            "base_currency": self.portfolio.base_currency,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    def _warnings(self) -> list[str]:
        warnings: list[str] = []
        observations = len(self.portfolio_returns)
        if self.market.stale:
            warnings.append(
                "Yahoo Finance could not be reached, so these figures use the last "
                "prices that were fetched successfully "
                f"({self.market.fetched_at.isoformat(timespec='seconds')})."
            )
        if observations < 30:
            warnings.append(
                f"Only {observations} daily return observations are available; "
                "risk statistics need at least 30 to be meaningful."
            )
        if self.market.raw_last_dates:
            stale = [
                ticker
                for ticker, last in self.market.raw_last_dates.items()
                if ticker in self.portfolio.tickers
                and (self.market.as_of - last).days > 5
            ]
            if stale:
                warnings.append(
                    "Prices are older than five calendar days for: " + ", ".join(sorted(stale))
                )
        if len(self.portfolio.holdings) < 3:
            warnings.append("A portfolio of fewer than three positions is highly concentrated.")
        if self.unpriced_tickers:
            warnings.append(
                "No price history for "
                + ", ".join(self.unpriced_tickers)
                + ", so the trades in them are left out of the history."
            )
        if self.ledger_replay is not None and self.market.dividends_in_prices:
            recorded = any(m.category == "dividend" for m in self.ledger_replay.movements)
            if recorded:
                warnings.append(
                    "These prices already include dividends (an older price cache), so "
                    "recorded dividends are reported as income but not added to cash until "
                    "prices are refreshed."
                )
        return warnings

    def _period_payload(self, period: metrics.PeriodKey) -> dict[str, Any]:
        change = metrics.period_change(
            self.equity,
            period,
            returns=self.portfolio_returns,
            flows=self.flows,
        )
        return {
            "period": change.period,
            "start_date": iso(change.start_date),
            "start_value": round_money(change.start_value),
            "end_value": round_money(change.end_value),
            "absolute": round_money(change.absolute),
            "pct": round_ratio(change.percent),
            "flows": round_money(change.flows),
        }

    def _allocation_breakdown(self, attribute: str) -> list[dict[str, Any]]:
        values = pd.Series({p.ticker: p.value_base for p in self.positions}, dtype=float)
        keys = pd.Series({p.ticker: getattr(p, attribute) for p in self.positions})
        grouped = values.groupby(keys).sum()
        counts = keys.value_counts()
        # Cash is part of what the portfolio holds: its own bucket by class
        # and region, and in its own currency by currency.
        for currency, value in self.cash_values.items():
            if value <= 0.005:
                continue
            key = currency if attribute == "currency" else "Cash"
            grouped[key] = float(grouped.get(key, 0.0)) + value
        grouped = grouped.sort_values(ascending=False)
        weights = metrics.allocation(grouped)
        return [
            {
                "key": str(key),
                "value": round_money(grouped[key]),
                "allocation_pct": round_ratio(weights[key]),
                "holdings": int(counts.get(key, 0)),
            }
            for key in grouped.index
        ]

    @cached_property
    def cash_values(self) -> dict[str, float]:
        """Cash held now per currency, valued in the base currency."""
        if self.ledger_replay is None or self.cash_frame.empty:
            return {}
        latest = self.cash_frame.iloc[-1]
        return {str(currency): float(value) for currency, value in latest.items() if abs(value) > 0.005}

    def _cash_payload(self) -> list[dict[str, Any]]:
        if not self.cash_values:
            return []
        balances = self.cash_balances.iloc[-1]
        total = float(self.total_value)
        return [
            {
                "currency": currency,
                "balance": round_money(float(balances[currency])),
                "value_base": round_money(value),
                "allocation_pct": round_ratio(value / total if total else None),
            }
            for currency, value in sorted(self.cash_values.items(), key=lambda item: -item[1])
        ]

    def _ledger_report(self) -> dict[str, Any] | None:
        """Income, charges and realised results, in the base currency.

        Every amount is converted at the rate of the day it was paid. A
        sale's realised result is its proceeds at the sale-day rate less the
        cost of the lots it used, each at the rate of the day it was bought,
        so it includes the currency's move while the units were held.
        """
        replayed = self.ledger_replay
        if replayed is None:
            return None

        categories = ("dividend", "withholding", "fee", "tax", "return_of_capital")
        totals = dict.fromkeys((*categories, "realized"), 0.0)
        by_year: dict[str, dict[str, float]] = {}
        by_ticker: dict[str, dict[str, float]] = {}

        def add(on: str, ticker: str | None, category: str, value: float) -> None:
            totals[category] += value
            year = by_year.setdefault(on[:4], dict.fromkeys(totals, 0.0))
            year[category] += value
            if ticker:
                row = by_ticker.setdefault(ticker, dict.fromkeys(totals, 0.0))
                row[category] += value

        movements = [*replayed.movements, *self.market_dividends]
        for movement in movements:
            if movement.category not in categories or not self._movement_applies(movement):
                continue
            position = self._first_position(movement.on)
            rate = self._rate_at(movement.currency or self.portfolio.base_currency, position)
            if np.isfinite(rate):
                add(movement.on, movement.ticker, movement.category, movement.value * rate)

        for sale in replayed.sales.values():
            currency = sale.currency or self._currency_of(sale.ticker)
            proceeds = sale.proceeds * self._rate_at(currency, self._first_position(sale.on))
            cost = sum(
                allocation.quantity
                * allocation.cost_per_unit
                * self._rate_at(currency, self._first_position(allocation.acquired))
                for allocation in sale.allocations
            )
            if np.isfinite(proceeds) and np.isfinite(cost):
                add(sale.on, sale.ticker, "realized", proceeds - cost)

        if self.market.dividends_in_prices:
            source = "in_prices"
        elif self.market_dividends:
            source = "market"
        elif totals["dividend"]:
            source = "recorded"
        else:
            source = "none"

        _, implicit, external = self._cash_book
        window = self.active_index

        def money(row: dict[str, float]) -> dict[str, Any]:
            return {
                "dividends": round_money(row["dividend"]),
                "withholding": round_money(row["withholding"]),
                "return_of_capital": round_money(row["return_of_capital"]),
                "fees": round_money(row["fee"]),
                "taxes": round_money(row["tax"]),
                "realized": round_money(row["realized"]),
                "net_income": round_money(row["dividend"] - row["withholding"] - row["fee"] - row["tax"]),
            }

        return {
            **money(totals),
            "dividends_source": source,
            "cash_value": round_money(sum(self.cash_values.values())),
            "cash": self._cash_payload(),
            "contributions_recorded": round_money(float(external.loc[window].sum())),
            "contributions_assumed": round_money(float(implicit.loc[window].iloc[1:].sum())),
            "by_year": [{"year": year, **money(row)} for year, row in sorted(by_year.items())],
            "by_position": [
                {"ticker": ticker, **money(row)} for ticker, row in sorted(by_ticker.items())
            ],
        }

    def _benchmark_summary(self) -> dict[str, Any]:
        benchmark = self.market.benchmark.reindex(self.active_index).ffill()
        if len(benchmark) < 2:
            return {}
        returns = metrics.daily_returns(benchmark)
        drawdown = metrics.max_drawdown(benchmark)
        return {
            "name": self.settings.benchmark_name,
            "symbol": self.settings.benchmark,
            "includes_dividends": self.settings.benchmark_includes_dividends,
            "return_pct": round_ratio(float(benchmark.iloc[-1] / benchmark.iloc[0] - 1.0)),
            "annualized_return_pct": round_ratio(
                metrics.annualized_return(returns, self.settings.trading_days_per_year)
            ),
            "volatility_annualized_pct": round_ratio(
                metrics.annualized_volatility(returns, self.settings.trading_days_per_year)
            ),
            "sharpe_ratio": round_ratio(
                metrics.sharpe_ratio(
                    returns, self.settings.daily_risk_free_rate, self.settings.trading_days_per_year
                )
            ),
            "max_drawdown_pct": round_ratio(drawdown.max_drawdown),
            "observations": int(len(returns)),
        }

    # ------------------------------------------------------------------
    # Endpoint payloads
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return json_safe(
            {
                "status": "ok",
                "version": API_VERSION,
                **self._envelope(),
                "holdings_count": len(self.portfolio.holdings),
                "benchmark": self.settings.benchmark,
                "history_start": to_iso_dates(self.active_index[:1])[0],
                "history_days": int(len(self.active_index)),
                "prices_fetched_at": self.market.fetched_at.isoformat(timespec="seconds"),
                "prices_stale": self.market.stale,
                "observations": int(len(self.portfolio_returns)),
                "warnings": self._warnings(),
            }
        )

    def holdings(self) -> dict[str, Any]:
        return json_safe(
            {
                **self._envelope(),
                "total_value": round_money(self.total_value),
                "cash": self._cash_payload(),
                "holdings": [
                    {
                        "ticker": p.ticker,
                        "name": p.name,
                        "asset_class": p.asset_class,
                        "region": p.region,
                        "currency": p.currency,
                        "quantity": round(p.quantity, 6),
                        "price_native": round_money(p.price_native),
                        "price_base": round_money(p.price_base),
                        "value_base": round_money(p.value_base),
                        "allocation_pct": round_ratio(p.allocation_pct),
                        "cost_basis_native": round_money(p.cost_basis_native),
                        "cost_basis_base": round_money(p.cost_basis_base),
                        "cost_total_base": round_money(p.cost_total_base),
                        "unrealized_pnl": round_money(p.unrealized_pnl),
                        "unrealized_pnl_pct": round_ratio(p.unrealized_pnl_pct),
                        "price_effect": round_money(p.price_effect),
                        "fx_effect": round_money(p.fx_effect),
                        "fx_rate_now": round(p.fx_rate_now, 6),
                        "fx_rate_at_acquisition": round(p.fx_rate_at_acquisition, 6),
                        "price_native_at_acquisition": (
                            round_money(p.price_native_at_acquisition)
                            if p.price_native_at_acquisition is not None
                            else None
                        ),
                        "target_weight": (
                            round_ratio(p.target_weight) if p.target_weight is not None else None
                        ),
                        "drift": round_ratio(p.drift) if p.drift is not None else None,
                        "day_change_pct": round_ratio(p.day_change_pct),
                        "acquired": p.acquired,
                        "sparkline": money_series(p.sparkline),
                    }
                    for p in self.positions
                ],
            }
        )

    def summary(self) -> dict[str, Any]:
        total_cost = float(sum(p.cost_total_base for p in self.positions))
        # Unrealised P&L is the positions against what they cost; cash has no cost.
        total_pnl = float(sum(p.value_base for p in self.positions)) - total_cost
        tail = self.equity.tail(SPARKLINE_DAYS)

        return json_safe(
            {
                **self._envelope(),
                "total_value": round_money(self.total_value),
                "total_cost": round_money(total_cost),
                "total_unrealized_pnl": round_money(total_pnl),
                "total_unrealized_pnl_pct": round_ratio(total_pnl / total_cost if total_cost else None),
                "holdings_count": len(self.positions),
                "changes": {period: self._period_payload(period) for period in PERIODS},
                "allocation_by_class": self._allocation_breakdown("asset_class"),
                "allocation_by_region": self._allocation_breakdown("region"),
                "allocation_by_currency": self._allocation_breakdown("currency"),
                "fx_attribution": self._fx_attribution(),
                "drift": self._drift_payload(),
                "attribution": self._attribution_payload(),
                "sparkline": {
                    "dates": to_iso_dates(tail.index),
                    "values": money_series(tail.to_numpy()),
                },
                "ledger": self._ledger_report(),
            }
        )

    def _fx_attribution(self) -> dict[str, Any]:
        """Split the unrealised P&L into price effect and currency effect.

        The two effects are computed per position and summed, so the totals
        reconcile with the reported unrealised P&L. Positions acquired before
        the price history starts have no entry price, so their P&L cannot be
        attributed; that remainder is reported rather than smeared across the
        others.
        """
        price_effect = 0.0
        fx_effect = 0.0
        unattributed = 0.0
        for position in self.positions:
            if position.price_effect is None or position.fx_effect is None:
                unattributed += position.unrealized_pnl
                continue
            price_effect += position.price_effect
            fx_effect += position.fx_effect
        return {
            "price_effect": round_money(price_effect),
            "fx_effect": round_money(fx_effect),
            "unattributed": round_money(unattributed),
            "total": round_money(price_effect + fx_effect + unattributed),
        }

    def replay(
        self,
        start: str | None = None,
        end: str | None = None,
        notional: float = 100_000.0,
    ) -> dict[str, Any]:
        """Run the current positions over a past window.

        This is a stress test of the *current* mix, not a reconstruction of
        what the owner held then: the same weights are applied to the prices
        of the chosen period. It answers the question people actually ask -
        "if I had this portfolio in that crash, what would it have done?" -
        and the answer is only as good as that framing, which the panel
        states in as many words.
        """
        growth = self.growth_index
        window = growth
        if start:
            window = window.loc[pd.Timestamp(start).normalize() :]
        if end:
            window = window.loc[: pd.Timestamp(end).normalize()]
        if len(window) < 2:
            raise ValueError("the replay window needs at least two trading days")

        benchmark = self.market.benchmark.reindex(self.active_index).ffill()
        benchmark_window = benchmark.reindex(window.index).ffill()
        if len(benchmark_window) < 2:
            benchmark_window = pd.Series(dtype=float)

        scaled = window / float(window.iloc[0]) * notional
        drawdown = metrics.max_drawdown(scaled)
        returns = metrics.daily_returns(scaled)
        best = returns.idxmax() if len(returns) else None
        worst = returns.idxmin() if len(returns) else None

        return json_safe(
            {
                **self._envelope(),
                "start_date": pd.Timestamp(window.index[0]).strftime("%Y-%m-%d"),
                "end_date": pd.Timestamp(window.index[-1]).strftime("%Y-%m-%d"),
                "notional": round_money(notional),
                "dates": to_iso_dates(window.index),
                "portfolio": money_series(scaled.to_numpy()),
                "benchmark": (
                    money_series(
                        (
                            benchmark_window / float(benchmark_window.iloc[0]) * notional
                        ).to_numpy()
                    )
                    if len(benchmark_window)
                    else []
                ),
                "drawdown_pct": ratio_series(metrics.drawdown_series(scaled).to_numpy()),
                "return_pct": round_ratio(float(scaled.iloc[-1] / scaled.iloc[0] - 1.0)),
                "annualized_return_pct": round_ratio(
                    metrics.annualized_return(returns, self.settings.trading_days_per_year)
                ),
                "volatility_annualized_pct": round_ratio(
                    metrics.annualized_volatility(returns, self.settings.trading_days_per_year)
                ),
                "max_drawdown": {
                    "pct": round_ratio(drawdown.max_drawdown),
                    "peak_date": iso(drawdown.peak_date),
                    "trough_date": iso(drawdown.trough_date),
                },
                "best_day": {
                    "date": iso(pd.Timestamp(best).date()) if best is not None else None,
                    "pct": round_ratio(float(returns.loc[best])) if best is not None else None,
                },
                "worst_day": {
                    "date": iso(pd.Timestamp(worst).date()) if worst is not None else None,
                    "pct": round_ratio(float(returns.loc[worst])) if worst is not None else None,
                },
                "observations": int(len(returns)),
            }
        )

    def what_if(self, targets: dict[str, float]) -> dict[str, Any]:
        """Rebuild the analytics with a proposed set of target weights.

        The positions named in the proposal are set to their target weight
        of today's value; the positions left out are scaled proportionally
        so that the portfolio is still worth the same amount. Money has to
        come from somewhere, and a proposal that silently created it would
        be a fantasy.

        The acquisition dates stay as they are, so the candidate history
        starts when the book started. The result is what the portfolio's
        risk would look like if the trades had been made - not a forecast
        of what they would earn.
        """
        from dataclasses import replace as dataclass_replace

        prices = self.market.prices_base.iloc[-1]
        total_value = float(self.total_value)
        current_weights = {p.ticker: float(p.allocation_pct) for p in self.positions}

        targeted_value = 0.0
        targeted_quantities: dict[str, float] = {}
        for holding in self.portfolio.holdings:
            weight = targets.get(holding.ticker)
            if weight is None:
                continue
            price = float(prices[holding.ticker])
            if price <= 0:
                continue
            quantity = (weight * total_value) / price
            targeted_quantities[holding.ticker] = quantity
            targeted_value += quantity * price

        # Everything not named keeps its relative weight, scaled to the
        # value that is left over.
        untargeted_value = sum(
            float(p.value_base)
            for p in self.positions
            if p.ticker not in targeted_quantities
        )
        residual_value = total_value - targeted_value
        scale = (
            residual_value / untargeted_value
            if untargeted_value > 0 and residual_value > 0
            else 1.0
        )

        new_holdings = []
        trades = []
        for holding in self.portfolio.holdings:
            if holding.ticker in targeted_quantities:
                quantity = targeted_quantities[holding.ticker]
                new_holdings.append(dataclass_replace(holding, quantity=quantity))
                trades.append(
                    {
                        "ticker": holding.ticker,
                        "from_weight": round_ratio(current_weights.get(holding.ticker, 0.0)),
                        "to_weight": round_ratio(targets[holding.ticker]),
                        "trade_value": round_money(
                            (targets[holding.ticker] - current_weights.get(holding.ticker, 0.0))
                            * total_value
                        ),
                    }
                )
                continue
            new_holdings.append(dataclass_replace(holding, quantity=holding.quantity * scale))
            trades.append(
                {
                    "ticker": holding.ticker,
                    "from_weight": round_ratio(current_weights.get(holding.ticker, 0.0)),
                    "to_weight": round_ratio(current_weights.get(holding.ticker, 0.0) * scale),
                    "trade_value": round_money(
                        (current_weights.get(holding.ticker, 0.0) * (scale - 1.0)) * total_value
                    ),
                }
            )

        candidate_portfolio = Portfolio(
            base_currency=self.portfolio.base_currency,
            holdings=tuple(new_holdings),
            cash_flows=self.portfolio.cash_flows,
        )
        candidate = PortfolioAnalytics(candidate_portfolio, self.market, self.settings)
        candidate_summary = candidate.summary()
        candidate_risk = candidate.risk()
        current_summary = self.summary()
        current_risk = self.risk()

        def headline(summary: dict[str, Any], risk: dict[str, Any]) -> dict[str, Any]:
            concentration = risk.get("concentration") or {}
            return {
                "annualized_return_pct": risk.get("annualized_return_pct"),
                "volatility_annualized_pct": risk.get("volatility_annualized_pct"),
                "sharpe_ratio": risk.get("sharpe_ratio"),
                "beta": (risk.get("beta") or {}).get("value"),
                "max_drawdown_pct": (risk.get("max_drawdown") or {}).get("pct"),
                "effective_holdings": concentration.get("effective_holdings"),
                "top_five_pct": concentration.get("top_five_pct"),
                "total_value": summary.get("total_value"),
            }

        return json_safe(
            {
                **self._envelope(),
                "trades": trades,
                "current": headline(current_summary, current_risk),
                "proposed": headline(candidate_summary, candidate_risk),
            }
        )

    def compare_with(self, symbol: str) -> dict[str, Any]:
        """Compare the portfolio against a different benchmark.

        The comparison is computed on the portfolio's own sample and returns
        the same statistics as the configured benchmark, so two benchmarks
        can be read side by side.
        """
        from .data import load_symbol_series

        daily = self.portfolio_returns
        if daily.empty:
            raise ValueError("the portfolio has no return history yet")

        start = self.active_index[0].date()
        end = (self.active_index[-1] + pd.Timedelta(days=1)).date()
        series = load_symbol_series(symbol, start, end, self.settings)
        aligned = series.reindex(self.active_index).ffill()
        benchmark_daily = metrics.daily_returns(aligned.reindex(daily.index))
        benchmark_daily = benchmark_daily.dropna()
        common = daily.reindex(benchmark_daily.index).dropna()
        benchmark_daily = benchmark_daily.reindex(common.index)

        alpha = metrics.jensen_alpha(
            common,
            benchmark_daily,
            self.settings.daily_risk_free_rate,
            self.settings.trading_days_per_year,
        )
        beta = metrics.beta(common, benchmark_daily)
        tracking_error = metrics.tracking_error(
            common, benchmark_daily, self.settings.trading_days_per_year
        )
        information_ratio = metrics.information_ratio(
            common, benchmark_daily, self.settings.trading_days_per_year
        )
        up_capture, down_capture = metrics.up_down_capture(common, benchmark_daily)
        drawdown = metrics.max_drawdown(aligned.reindex(common.index).dropna())
        portfolio_total = float((1.0 + common).prod() - 1.0)
        benchmark_total = float((1.0 + benchmark_daily).prod() - 1.0)

        rebased = aligned.reindex(common.index).ffill()
        rebased = rebased / float(rebased.iloc[0]) * float(self.total_value)

        return json_safe(
            {
                **self._envelope(),
                "symbol": symbol,
                "name": symbol,
                "correlation": round_ratio(metrics.correlation(common, benchmark_daily)),
                "alpha_annualized_pct": round_ratio(alpha),
                "beta": round_ratio(beta),
                "tracking_error_pct": round_ratio(tracking_error),
                "information_ratio": round_ratio(information_ratio),
                "up_capture": round_ratio(up_capture),
                "down_capture": round_ratio(down_capture),
                "max_drawdown_pct": round_ratio(drawdown.max_drawdown),
                "portfolio_return_pct": round_ratio(portfolio_total),
                "benchmark_return_pct": round_ratio(benchmark_total),
                "active_return_pct": round_ratio(portfolio_total - benchmark_total),
                "observations": int(len(common)),
                "dates": to_iso_dates(common.index),
                "portfolio": money_series(self.equity.reindex(common.index).to_numpy()),
                "benchmark": money_series(rebased.to_numpy()),
            }
        )

    def _attribution_payload(self) -> dict[str, Any]:
        """Attribute the active return to positions and to buckets.

        The active return is what the portfolio earned above its benchmark.
        This says where it came from: which positions paid for it, and which
        parts of the book.
        """
        daily = self.portfolio_returns
        benchmark_daily = self.benchmark_returns
        if daily.empty:
            return {"positions": [], "by_region": [], "by_asset_class": [], "residual": 0.0}

        values = self.value_frame.reindex(daily.index)
        equity = self.equity.reindex(daily.index)
        holding_returns = self.asset_returns.reindex(daily.index)
        contributions = metrics.active_return_attribution(
            values, equity, holding_returns, benchmark_daily.reindex(daily.index)
        )
        if contributions.empty:
            return {"positions": [], "by_region": [], "by_asset_class": [], "residual": 0.0}

        active_total = float((1.0 + daily).prod() - (1.0 + benchmark_daily.reindex(daily.index)).prod())

        positions = []
        for position in self.positions:
            contribution = float(contributions.get(position.ticker, 0.0))
            positions.append(
                {
                    "ticker": position.ticker,
                    "name": position.name,
                    "region": position.region,
                    "asset_class": position.asset_class,
                    "weight": round_ratio(position.allocation_pct),
                    "contribution_pct": round_ratio(contribution),
                }
            )
        positions.sort(key=lambda row: abs(float(row["contribution_pct"])), reverse=True)

        def grouped(attribute: str) -> list[dict[str, Any]]:
            buckets: dict[str, float] = {}
            for position in self.positions:
                key = getattr(position, attribute) or "Unclassified"
                buckets[key] = buckets.get(key, 0.0) + float(
                    contributions.get(position.ticker, 0.0)
                )
            rows = [
                {"key": key, "contribution_pct": round_ratio(value)}
                for key, value in buckets.items()
            ]
            rows.sort(key=lambda row: abs(float(row["contribution_pct"])), reverse=True)
            return rows

        explained = float(contributions.sum())
        return {
            "positions": positions,
            "by_region": grouped("region"),
            "by_asset_class": grouped("asset_class"),
            "active_return_pct": round_ratio(active_total),
            # The difference between the explained part and the active return
            # is compounding and cash flows, not a missing position.
            "residual": round_ratio(active_total - explained),
        }

    def _drift_payload(self) -> dict[str, Any]:
        """How far the portfolio has drifted from its target weights.

        A position drifts when its price moves differently from the rest of
        the book: the position that was supposed to be 10% is now 17% without
        a single trade. The rebalance figures are the trades that would put
        it back, and the turnover is what that would cost in fees and tax.
        """
        positions = [p for p in self.positions if p.target_weight is not None]
        if not positions:
            return {
                "has_targets": False,
                "positions": [],
                "total_drift": 0.0,
                "turnover": 0.0,
                "target_sum": 0.0,
                "residual": 0.0,
            }

        total_value = float(self.total_value)
        rows = []
        buys = 0.0
        sells = 0.0
        drift_sum = 0.0
        target_sum = 0.0
        for position in positions:
            target = float(position.target_weight or 0.0)
            current = float(position.allocation_pct)
            drift = current - target
            trade = -drift * total_value
            if trade > 0:
                buys += trade
            else:
                sells += -trade
            drift_sum += abs(drift)
            target_sum += target
            rows.append(
                {
                    "ticker": position.ticker,
                    "current_weight": round_ratio(current),
                    "target_weight": round_ratio(target),
                    "drift": round_ratio(drift),
                    "trade_value": round_money(trade),
                }
            )
        rows.sort(key=lambda row: abs(float(row["drift"])), reverse=True)

        return {
            "has_targets": True,
            "positions": rows,
            # Half the sum of absolute drifts is the turnover needed to rebalance
            # a fully invested book: every trade moves two weights.
            "total_drift": round_ratio(drift_sum / 2.0),
            "turnover": round_money(min(buys, sells)),
            "target_sum": round_ratio(target_sum),
            # What is left over if the targets do not add up to one.
            "residual": round_ratio(1.0 - target_sum),
        }

    def history(self) -> dict[str, Any]:
        dates = to_iso_dates(self.active_index)
        benchmark = self.market.benchmark.reindex(self.active_index).ffill()
        growth = self.growth_value
        # Rebase the benchmark onto the same starting capital as the growth line.
        rebased = benchmark / float(benchmark.iloc[0]) * float(growth.iloc[0]) if len(benchmark) else benchmark

        return json_safe(
            {
                **self._envelope(),
                "benchmark": self.settings.benchmark,
                "benchmark_name": self.settings.benchmark_name,
                "methodology": "time-weighted, contributions excluded",
                "dates": dates,
                "portfolio": money_series(growth.to_numpy()),
                "portfolio_value": money_series(self.equity.to_numpy()),
                "benchmark_rebased": money_series(rebased.to_numpy()),
                "drawdown_pct": ratio_series(metrics.drawdown_series(growth).to_numpy()),
                "per_holding": {
                    ticker: money_series(self.value_frame[ticker].to_numpy())
                    for ticker in self.portfolio.tickers
                },
                "flows": [
                    {"date": pd.Timestamp(stamp).strftime("%Y-%m-%d"), "amount": round_money(value)}
                    for stamp, value in self.flows.items()
                    if value
                ],
                "flow_source": self.flow_source,
            }
        )

    def returns(self) -> dict[str, Any]:
        daily = self.portfolio_returns
        cumulative = (1.0 + daily).cumprod() - 1.0
        wins = daily[daily > 0]
        losses = daily[daily < 0]

        monthly = daily.resample("ME").apply(lambda window: float((1.0 + window).prod() - 1.0))
        yearly = daily.resample("YE").apply(lambda window: float((1.0 + window).prod() - 1.0))

        best_stamp = daily.idxmax() if len(daily) else None
        worst_stamp = daily.idxmin() if len(daily) else None

        histogram = []
        if len(daily):
            counts, edges = np.histogram(daily.to_numpy(dtype=float), bins=31)
            histogram = [
                {
                    "start": round_ratio(float(edges[i])),
                    "end": round_ratio(float(edges[i + 1])),
                    "count": int(counts[i]),
                }
                for i in range(len(counts))
            ]

        return json_safe(
            {
                **self._envelope(),
                "methodology": "time-weighted daily returns",
                "dates": to_iso_dates(daily.index),
                "daily_pct": ratio_series(daily.to_numpy()),
                "cumulative_pct": ratio_series(cumulative.to_numpy()),
                "monthly_pct": [
                    {"month": pd.Timestamp(stamp).strftime("%Y-%m"), "pct": round_ratio(value)}
                    for stamp, value in monthly.items()
                ],
                "yearly_pct": [
                    {"year": pd.Timestamp(stamp).strftime("%Y"), "pct": round_ratio(value)}
                    for stamp, value in yearly.items()
                ],
                "histogram": histogram,
                "observations": int(len(daily)),
                "best_day": {
                    "date": iso(pd.Timestamp(best_stamp).date()) if best_stamp is not None else None,
                    "pct": round_ratio(float(daily.loc[best_stamp])) if best_stamp is not None else None,
                },
                "worst_day": {
                    "date": iso(pd.Timestamp(worst_stamp).date()) if worst_stamp is not None else None,
                    "pct": round_ratio(float(daily.loc[worst_stamp])) if worst_stamp is not None else None,
                },
                "positive_days": int(len(wins)),
                "negative_days": int(len(losses)),
                "hit_rate_pct": round_ratio(len(wins) / len(daily) if len(daily) else None),
                "average_gain_pct": round_ratio(float(wins.mean()) if len(wins) else None),
                "average_loss_pct": round_ratio(float(losses.mean()) if len(losses) else None),
                "annualized_return_pct": round_ratio(
                    metrics.annualized_return(daily, self.settings.trading_days_per_year)
                ),
                "best_month_pct": round_ratio(float(monthly.max()) if len(monthly) else None),
                "worst_month_pct": round_ratio(float(monthly.min()) if len(monthly) else None),
            }
        )

    def risk(self) -> dict[str, Any]:
        daily = self.portfolio_returns
        benchmark_daily = self.benchmark_returns
        rf_daily = self.settings.daily_risk_free_rate
        trading_days = self.settings.trading_days_per_year
        drawdown = metrics.max_drawdown(self.growth_value)
        correlation = metrics.correlation_matrix(self.asset_returns)
        benchmark = benchmark_daily.reindex(daily.index).dropna() if len(daily) else benchmark_daily

        value_at_risk: dict[str, Any] = {}
        for confidence in self.settings.var_confidences:
            label = f"{int(confidence * 100)}"
            historical = metrics.historical_var(daily, confidence)
            parametric = metrics.parametric_var(daily, confidence)
            cvar = metrics.historical_cvar(daily, confidence)
            value_at_risk[label] = {
                "confidence": confidence,
                "historical_pct": round_ratio(historical),
                "parametric_pct": round_ratio(parametric),
                "historical_value": round_money(historical * self.total_value),
                "parametric_value": round_money(parametric * self.total_value),
                "cvar_pct": round_ratio(cvar),
                "cvar_value": round_money(cvar * self.total_value),
            }

        weights = pd.Series(
            {position.ticker: position.value_base for position in self.positions}, dtype=float
        )
        concentration = metrics.concentration(weights)
        contributions = metrics.risk_contributions(self.asset_returns, weights)

        up_capture, down_capture = metrics.up_down_capture(daily, benchmark_daily)
        benchmark_drawdown = metrics.max_drawdown(
            self.market.benchmark.reindex(self.active_index).ffill()
        )
        money_weighted = self.money_weighted_return()

        return json_safe(
            {
                **self._envelope(),
                "lookback_days": int(len(daily)),
                "risk_free_rate": self.settings.risk_free_rate,
                "trading_days_per_year": trading_days,
                "annualized_return_pct": round_ratio(
                    metrics.annualized_return(daily, trading_days)
                ),
                "money_weighted_return_pct": round_ratio(money_weighted),
                "money_weighted_source": self.flow_source,
                "volatility_annualized_pct": round_ratio(
                    metrics.annualized_volatility(daily, trading_days)
                ),
                "downside_deviation_pct": round_ratio(
                    metrics.downside_deviation(daily, rf_daily, trading_days)
                ),
                "sharpe_ratio": round_ratio(metrics.sharpe_ratio(daily, rf_daily, trading_days)),
                "sortino_ratio": round_ratio(metrics.sortino_ratio(daily, rf_daily, trading_days)),
                "calmar_ratio": round_ratio(metrics.calmar_ratio(daily, self.growth_value, trading_days)),
                "max_drawdown": {
                    "pct": round_ratio(drawdown.max_drawdown),
                    "peak_date": iso(drawdown.peak_date),
                    "trough_date": iso(drawdown.trough_date),
                    "peak_value": round_money(drawdown.peak_value),
                    "trough_value": round_money(drawdown.trough_value),
                    "recovery_date": iso(drawdown.recovery_date),
                },
                "value_at_risk": value_at_risk,
                "beta": {
                    "value": round_ratio(metrics.beta(daily, benchmark_daily)),
                    "benchmark": self.settings.benchmark,
                    "benchmark_name": self.settings.benchmark_name,
                },
                "benchmark": {
                    "name": self.settings.benchmark_name,
                    "symbol": self.settings.benchmark,
                    "correlation": round_ratio(
                        float(daily.corr(benchmark)) if len(daily) > 1 and len(benchmark) > 1 else None
                    ),
                    "alpha_annualized_pct": round_ratio(
                        metrics.jensen_alpha(daily, benchmark_daily, rf_daily, trading_days)
                    ),
                    "tracking_error_pct": round_ratio(
                        metrics.tracking_error(daily, benchmark_daily, trading_days)
                    ),
                    "information_ratio": round_ratio(
                        metrics.information_ratio(daily, benchmark_daily, trading_days)
                    ),
                    "up_capture": round_ratio(up_capture),
                    "down_capture": round_ratio(down_capture),
                    "max_drawdown_pct": round_ratio(benchmark_drawdown.max_drawdown),
                    **self._benchmark_summary(),
                },
                "concentration": {
                    "herfindahl": round_ratio(concentration.herfindahl),
                    "effective_holdings": round_ratio(concentration.effective_holdings),
                    "top_five_pct": round_ratio(concentration.top_five),
                    "largest_pct": round_ratio(concentration.largest),
                },
                "risk_contribution": [
                    {
                        "ticker": ticker,
                        "weight": round_ratio(row["weight"]),
                        "contribution_pct": round_ratio(row["contribution_pct"]),
                    }
                    for ticker, row in contributions.iterrows()
                ],
                "correlation": {
                    "tickers": list(correlation.columns),
                    "matrix": [ratio_series(row) for row in correlation.to_numpy()],
                },
                "warnings": self._warnings(),
            }
        )

    def montecarlo(self) -> dict[str, Any]:
        result = self.monte_carlo

        future = pd.bdate_range(
            start=pd.Timestamp(self.market.as_of) + pd.Timedelta(days=1),
            periods=result.horizon_days,
        )
        dates = [self.as_of, *to_iso_dates(future)]

        return json_safe(
            {
                **self._envelope(),
                "paths": result.paths,
                "horizon_days": result.horizon_days,
                "start_value": round_money(result.start_value),
                "dates": dates,
                "percentile_bands": {
                    key: money_series(values) for key, values in result.percentile_bands.items()
                },
                "final_values": {
                    key: round_money(value) for key, value in result.final_values_summary.items()
                },
                "histogram": [
                    {
                        "start": round_money(bucket.start),
                        "end": round_money(bucket.end),
                        "count": bucket.count,
                        "probability": round_ratio(bucket.probability),
                    }
                    for bucket in result.histogram
                ],
                "expected_value": round_money(result.expected_value),
                "median_value": round_money(result.median_value),
                "probability_below_start_pct": round_ratio(result.probability_below_start),
                "expected_return_pct": round_ratio(result.expected_return_pct),
                "annualized_drift_pct": round_ratio(result.annualized_drift_pct),
                "assumptions": {
                    "distribution": "multivariate normal on daily log returns",
                    "correlation": "historical covariance across all holdings",
                    "rebalancing": "none (buy and hold, weights drift)",
                    "lookback_days": int(len(self.asset_returns)),
                    "fees": "excluded",
                },
            }
        )

    def all_payloads(self) -> dict[str, Any]:
        return {
            "/health": self.health(),
            "/holdings": self.holdings(),
            "/portfolio/summary": self.summary(),
            "/portfolio/history": self.history(),
            "/portfolio/returns": self.returns(),
            "/portfolio/risk": self.risk(),
            "/portfolio/montecarlo": self.montecarlo(),
        }


def build_analytics(
    settings: Settings = SETTINGS,
    *,
    use_cache: bool = True,
    portfolio: Portfolio | None = None,
) -> PortfolioAnalytics:
    """Load positions and market data, and return a ready analytics instance.

    ``portfolio`` is supplied by the snapshot generator when it reads a
    standalone JSON file instead of the live SQLite store.
    """
    from .data import load_market_data
    from .store import build_portfolio

    resolved = portfolio or build_portfolio(settings)
    market = load_market_data(resolved, settings, use_cache=use_cache)
    return PortfolioAnalytics(resolved, market, settings)


__all__ = [
    "AnalyticsUnavailable",
    "API_VERSION",
    "PortfolioAnalytics",
    "PositionView",
    "build_analytics",
]
