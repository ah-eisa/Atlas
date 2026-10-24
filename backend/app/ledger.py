"""The portfolio's book of record, replayed.

Every event that changes what the portfolio owns or the cash it holds is one
:class:`LedgerEvent`: trades (with their fees and taxes), dividends (with the
tax withheld from them), standalone fees and taxes, corporate actions
(splits, symbol changes and mergers, spin-offs, returns of capital), currency
conversions, and the owner's own deposits and withdrawals.

Positions are never edited incrementally. :func:`replay` walks the events in
date order and rebuilds everything from them: the open lots of each position,
the realised result of each sale, and a dated list of :class:`Movement` -
units in and out of each position, cash in and out of each currency - which
the analytics turn into a daily history. Because nothing is incremental, a
backdated entry or a deletion is just another replay, and a ledger that no
longer adds up (a sale of units that were never there) is refused as a whole
rather than half-applied.

Conventions
-----------
* Prices, fees, taxes and dividends are in the currency they were paid in.
  A trade's currency is its instrument's quote currency.
* A purchase's fee is part of what the units cost: it is added to the lot's
  cost per unit. A sale's fee reduces its proceeds, so it reduces the
  realised result. A tax on a sale is reported on its own and is not part of
  the realised result, which is therefore before tax.
* Lots are matched first in, first out. A sale can only use units already
  held on its date.
* A split multiplies the units of every lot held on its date and divides
  their cost per unit, so the cost of the position is unchanged.
* A position edited by hand (an ``ADJUSTMENT``) is the new truth for its
  ticker: unit events recorded before it no longer apply.

The module is pure: no database, no network, no prices.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

# Units below this are treated as zero, so floating-point residue from a sale
# never leaves a dust position behind.
QTY_EPS = 1e-6

UNIT_KINDS = frozenset(
    {"ADJUSTMENT", "BUY", "SELL", "SPLIT", "SYMBOL_CHANGE", "SPINOFF", "RETURN_OF_CAPITAL"}
)
CASH_KINDS = frozenset({"DEPOSIT", "WITHDRAWAL", "FX", "DIVIDEND", "FEE", "TAX"})
KINDS = UNIT_KINDS | CASH_KINDS

# Order of events that share a date. Money arrives and corporate actions take
# effect before the day's trading; a purchase is available to a sale on the
# same day; income and charges follow; a withdrawal comes last.
_DAY_ORDER = {
    "DEPOSIT": 0,
    "FX": 1,
    "ADJUSTMENT": 2,
    "SPLIT": 3,
    "SYMBOL_CHANGE": 4,
    "SPINOFF": 5,
    "BUY": 6,
    "SELL": 7,
    "DIVIDEND": 8,
    "RETURN_OF_CAPITAL": 9,
    "FEE": 10,
    "TAX": 11,
    "WITHDRAWAL": 12,
}


class LedgerError(ValueError):
    """The events do not add up; ``key`` names the event that breaks them."""

    def __init__(self, key: str, message: str) -> None:
        super().__init__(message)
        self.key = key


@dataclass(frozen=True)
class LedgerEvent:
    """One entry in the book of record.

    Attributes:
        key: Stable identity, e.g. ``tx:12`` for a trade or ``ev:3`` for any
            other recorded event.
        kind: One of :data:`KINDS`.
        on: ISO date the event took effect (the trade date, the pay date).
        seq: Recording order. Breaks ties on the same date and decides which
            events an ``ADJUSTMENT`` supersedes.
        ticker: The position concerned, for unit events, dividends and any
            fee or tax that belongs to a position.
        quantity: Units bought or sold; for ``ADJUSTMENT`` the units held.
        price: Price per unit for a trade; cost per unit for ``ADJUSTMENT``.
        amount: Cash amount: a dividend's gross amount, a fee, a tax, a
            deposit or withdrawal (always positive), a return of capital, the
            amount sold in a currency conversion.
        currency: Currency of ``price``, ``amount``, ``fee`` and ``tax``.
        fee: A trade's commission, or a conversion's charge.
        tax: Tax on a sale, or tax withheld from a dividend.
        ratio: ``SPLIT``: new units per old unit (4.0 for a 4-for-1, 0.1 for a
            1-for-10 reverse split). ``SYMBOL_CHANGE`` and ``SPINOFF``: units
            of ``new_ticker`` received per unit held.
        new_ticker: The instrument received in a symbol change, merger or
            spin-off.
        cost_fraction: ``SPINOFF``: share of the parent's cost that moves to
            the new position (as the issuer reports it, for tax purposes).
        to_currency: ``FX``: the currency bought.
        to_amount: ``FX``: the amount of ``to_currency`` received.
        external: For ``DEPOSIT``/``WITHDRAWAL``: the amount in the base
            currency, which is what an external flow is measured in.
        source: ``recorded`` by the owner, or ``market`` for a dividend
            derived from market data.
        note: The owner's own description.
    """

    key: str
    kind: str
    on: str
    seq: int = 0
    ticker: str | None = None
    quantity: float = 0.0
    price: float = 0.0
    amount: float = 0.0
    currency: str | None = None
    fee: float = 0.0
    tax: float = 0.0
    ratio: float = 1.0
    new_ticker: str | None = None
    cost_fraction: float = 0.0
    to_currency: str | None = None
    to_amount: float = 0.0
    external: float = 0.0
    source: str = "recorded"
    note: str = ""


@dataclass
class OpenLot:
    """Units of a position that arrived together and have not been sold."""

    origin: str
    ticker: str
    acquired: str
    quantity: float
    cost_per_unit: float

    @property
    def transaction_id(self) -> int | None:
        """The trade that opened the lot, when it was a purchase."""
        return int(self.origin[3:]) if self.origin.startswith("tx:") else None


@dataclass(frozen=True)
class Allocation:
    """What a sale took from one lot."""

    origin: str
    acquired: str
    quantity: float
    cost_per_unit: float


@dataclass(frozen=True)
class SaleResult:
    """A sale, costed against the lots it consumed."""

    key: str
    ticker: str
    on: str
    quantity: float
    proceeds: float
    cost: float
    realized: float
    currency: str | None
    allocations: tuple[Allocation, ...]


@dataclass(frozen=True)
class Movement:
    """One dated change to the portfolio, in the form the analytics need.

    ``units`` are actual units of ``ticker`` (before any later split). ``cash``
    holds signed amounts per currency. ``external`` is money the owner moved
    in (positive) or out (negative), in the base currency. ``category`` and
    ``value`` classify income and charges for reporting: ``dividend``,
    ``withholding``, ``fee``, ``tax`` or ``return_of_capital``, in
    ``currency``.
    """

    on: str
    key: str
    kind: str
    ticker: str | None = None
    units: float = 0.0
    cash: tuple[tuple[str, float], ...] = ()
    external: float = 0.0
    category: str | None = None
    value: float = 0.0
    currency: str | None = None
    # A position that enters at a price nobody recorded (a hand-edited
    # position) is funded at its market value on the day, as the analytics
    # have always assumed; the analytics price this leg themselves.
    at_market: bool = False


@dataclass
class Replay:
    """Everything the events add up to."""

    lots: dict[str, list[OpenLot]] = field(default_factory=dict)
    sales: dict[str, SaleResult] = field(default_factory=dict)
    movements: list[Movement] = field(default_factory=list)
    # Splits per ticker, as (date, ratio): the analytics restate history in
    # today's units with them.
    splits: dict[str, list[tuple[str, float]]] = field(default_factory=dict)
    superseded: set[str] = field(default_factory=set)
    # The currency each position trades in, as the events recorded it.
    currencies: dict[str, str] = field(default_factory=dict)

    def units(self, ticker: str) -> float:
        return sum(lot.quantity for lot in self.lots.get(ticker, []))

    def position(self, ticker: str) -> tuple[float, float, str | None]:
        """Units, average cost per unit and earliest acquisition of a position."""
        lots = self.lots.get(ticker, [])
        quantity = sum(lot.quantity for lot in lots)
        if quantity <= QTY_EPS:
            return 0.0, 0.0, None
        cost = sum(lot.quantity * lot.cost_per_unit for lot in lots)
        return quantity, cost / quantity, min(lot.acquired for lot in lots)


def sort_key(event: LedgerEvent) -> tuple[str, int, int]:
    return (event.on[:10], _DAY_ORDER.get(event.kind, 99), event.seq)


def _superseded(events: list[LedgerEvent]) -> set[str]:
    """Unit events recorded before the latest adjustment of their ticker."""
    latest: dict[str, int] = {}
    for event in events:
        if event.kind == "ADJUSTMENT" and event.ticker:
            latest[event.ticker] = max(latest.get(event.ticker, -1), event.seq)
    result: set[str] = set()
    for event in events:
        if event.kind in UNIT_KINDS and event.kind != "ADJUSTMENT" and event.ticker in latest:
            if event.seq < latest[event.ticker]:
                result.add(event.key)
        if event.kind == "ADJUSTMENT" and event.ticker and event.seq < latest[event.ticker]:
            result.add(event.key)
    return result


def replay(events: list[LedgerEvent] | tuple[LedgerEvent, ...], base_currency: str = "EUR") -> Replay:
    """Rebuild the portfolio from its events.

    Raises:
        LedgerError: when an event cannot apply, e.g. a sale of more units
            than were held on its date, or a split of a position not held.
    """
    ordered = sorted(events, key=sort_key)
    result = Replay()
    result.superseded = _superseded(ordered)
    lots: dict[str, list[OpenLot]] = defaultdict(list)

    for event in ordered:
        if event.key in result.superseded:
            continue
        if event.kind not in KINDS:
            raise LedgerError(event.key, f"unknown event kind {event.kind!r}")
        on = event.on[:10]
        ticker = (event.ticker or "").upper() or None
        currency = (event.currency or "").upper() or None
        if ticker and currency and event.kind in UNIT_KINDS:
            result.currencies.setdefault(ticker, currency)

        if event.kind == "DEPOSIT" or event.kind == "WITHDRAWAL":
            sign = 1.0 if event.kind == "DEPOSIT" else -1.0
            amount = abs(event.amount)
            external = abs(event.external) if event.external else amount
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    event.kind,
                    cash=((currency or base_currency, sign * amount),),
                    external=sign * external,
                )
            )

        elif event.kind == "FX":
            if not currency or not event.to_currency:
                raise LedgerError(event.key, "a currency conversion needs both currencies")
            if event.amount <= 0 or event.to_amount <= 0:
                raise LedgerError(event.key, "a currency conversion needs both amounts")
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    "FX",
                    cash=(
                        (currency, -(event.amount + event.fee)),
                        (event.to_currency.upper(), event.to_amount),
                    ),
                    category="fee" if event.fee else None,
                    value=event.fee,
                    currency=currency,
                )
            )

        elif event.kind == "ADJUSTMENT":
            if ticker is None:
                raise LedgerError(event.key, "an adjustment needs a ticker")
            held = sum(lot.quantity for lot in lots[ticker])
            lots[ticker] = []
            if event.quantity > QTY_EPS:
                lots[ticker].append(
                    OpenLot(event.key, ticker, on, event.quantity, max(event.price, 0.0))
                )
            delta = event.quantity - held
            if abs(delta) > QTY_EPS:
                result.movements.append(
                    Movement(on, event.key, "ADJUSTMENT", ticker, units=delta, at_market=True)
                )

        elif event.kind == "BUY":
            if ticker is None or event.quantity <= 0:
                raise LedgerError(event.key, "a purchase needs a ticker and a positive quantity")
            cost = event.quantity * event.price + event.fee
            lots[ticker].append(
                OpenLot(event.key, ticker, on, event.quantity, cost / event.quantity)
            )
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    "BUY",
                    ticker,
                    units=event.quantity,
                    cash=((currency or base_currency, -(cost + event.tax)),),
                )
            )
            _charges(result, event, on, ticker, currency or base_currency, tax_category="tax")

        elif event.kind == "SELL":
            if ticker is None or event.quantity <= 0:
                raise LedgerError(event.key, "a sale needs a ticker and a positive quantity")
            eligible = [lot for lot in lots[ticker] if lot.acquired <= on]
            available = sum(lot.quantity for lot in eligible)
            if available + QTY_EPS < event.quantity:
                # Events replay in date order, so what is held here is what
                # was held on the sale's date.
                raise LedgerError(
                    event.key,
                    f"Cannot sell {event.quantity:g} of {ticker} on {on}: "
                    f"only {available:g} held on that date",
                )
            remaining = event.quantity
            taken: list[Allocation] = []
            cost = 0.0
            for lot in eligible:
                if remaining <= QTY_EPS:
                    break
                take = min(lot.quantity, remaining)
                taken.append(Allocation(lot.origin, lot.acquired, take, lot.cost_per_unit))
                cost += take * lot.cost_per_unit
                lot.quantity -= take
                remaining -= take
            lots[ticker] = [lot for lot in lots[ticker] if lot.quantity > QTY_EPS]
            proceeds = event.quantity * event.price - event.fee
            result.sales[event.key] = SaleResult(
                event.key,
                ticker,
                on,
                event.quantity,
                proceeds,
                cost,
                proceeds - cost,
                currency,
                tuple(taken),
            )
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    "SELL",
                    ticker,
                    units=-event.quantity,
                    cash=((currency or base_currency, proceeds - event.tax),),
                )
            )
            _charges(result, event, on, ticker, currency or base_currency, tax_category="tax")

        elif event.kind == "SPLIT":
            if ticker is None or event.ratio <= 0:
                raise LedgerError(event.key, "a split needs a ticker and a positive ratio")
            held_lots = [lot for lot in lots[ticker] if lot.acquired <= on]
            if not held_lots:
                raise LedgerError(event.key, f"{ticker} was not held on {on}, so it cannot split")
            added = 0.0
            for lot in held_lots:
                added += lot.quantity * (event.ratio - 1.0)
                lot.quantity *= event.ratio
                lot.cost_per_unit /= event.ratio
            result.splits.setdefault(ticker, []).append((on, event.ratio))
            result.movements.append(Movement(on, event.key, "SPLIT", ticker, units=added))

        elif event.kind == "SYMBOL_CHANGE":
            target = (event.new_ticker or "").upper()
            if ticker is None or not target or event.ratio <= 0:
                raise LedgerError(
                    event.key, "a symbol change needs the old and new tickers and a ratio"
                )
            held_lots = [lot for lot in lots[ticker] if lot.acquired <= on]
            if not held_lots:
                raise LedgerError(event.key, f"{ticker} was not held on {on}")
            moved = 0.0
            for lot in held_lots:
                moved += lot.quantity
                lots[target].append(
                    OpenLot(
                        lot.origin,
                        target,
                        lot.acquired,
                        lot.quantity * event.ratio,
                        lot.cost_per_unit / event.ratio,
                    )
                )
            moved_ids = {id(lot) for lot in held_lots}
            lots[ticker] = [lot for lot in lots[ticker] if id(lot) not in moved_ids]
            if ticker in result.currencies:
                result.currencies.setdefault(target, result.currencies[ticker])
            result.movements.append(Movement(on, event.key, "SYMBOL_CHANGE", ticker, units=-moved))
            result.movements.append(
                Movement(on, event.key, "SYMBOL_CHANGE", target, units=moved * event.ratio)
            )

        elif event.kind == "SPINOFF":
            target = (event.new_ticker or "").upper()
            if ticker is None or not target or event.ratio <= 0:
                raise LedgerError(event.key, "a spin-off needs both tickers and a ratio")
            if not 0.0 <= event.cost_fraction <= 1.0:
                raise LedgerError(event.key, "the share of cost moved must be between 0 and 1")
            held_lots = [lot for lot in lots[ticker] if lot.acquired <= on]
            if not held_lots:
                raise LedgerError(event.key, f"{ticker} was not held on {on}")
            received = 0.0
            for lot in held_lots:
                new_units = lot.quantity * event.ratio
                moved_cost = lot.quantity * lot.cost_per_unit * event.cost_fraction
                lot.cost_per_unit *= 1.0 - event.cost_fraction
                received += new_units
                lots[target].append(
                    OpenLot(
                        f"{event.key}:{lot.origin}",
                        target,
                        lot.acquired,
                        new_units,
                        moved_cost / new_units if new_units > QTY_EPS else 0.0,
                    )
                )
            if currency:
                result.currencies.setdefault(target, currency)
            result.movements.append(Movement(on, event.key, "SPINOFF", target, units=received))

        elif event.kind == "RETURN_OF_CAPITAL":
            if ticker is None or event.amount <= 0:
                raise LedgerError(event.key, "a return of capital needs a ticker and an amount")
            held_lots = [lot for lot in lots[ticker] if lot.acquired <= on]
            held = sum(lot.quantity for lot in held_lots)
            if held <= QTY_EPS:
                raise LedgerError(event.key, f"{ticker} was not held on {on}")
            per_unit = event.amount / held
            excess = 0.0
            for lot in held_lots:
                reduction = min(per_unit, lot.cost_per_unit)
                excess += (per_unit - reduction) * lot.quantity
                lot.cost_per_unit -= reduction
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    "RETURN_OF_CAPITAL",
                    ticker,
                    cash=((currency or base_currency, event.amount),),
                    category="return_of_capital",
                    value=event.amount,
                    currency=currency or base_currency,
                )
            )
            if excess > QTY_EPS:
                # Capital returned beyond the cost is a gain, realised now.
                result.sales[event.key] = SaleResult(
                    event.key, ticker, on, 0.0, excess, 0.0, excess, currency, ()
                )

        elif event.kind == "DIVIDEND":
            if event.amount <= 0:
                raise LedgerError(event.key, "a dividend needs a positive amount")
            pay = currency or result.currencies.get(ticker or "", base_currency)
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    "DIVIDEND",
                    ticker,
                    cash=((pay, event.amount - event.tax),),
                    category="dividend",
                    value=event.amount,
                    currency=pay,
                )
            )
            if event.tax:
                result.movements.append(
                    Movement(
                        on,
                        event.key,
                        "DIVIDEND",
                        ticker,
                        category="withholding",
                        value=event.tax,
                        currency=pay,
                    )
                )

        elif event.kind in ("FEE", "TAX"):
            if event.amount <= 0:
                raise LedgerError(event.key, f"a {event.kind.lower()} needs a positive amount")
            pay = currency or base_currency
            result.movements.append(
                Movement(
                    on,
                    event.key,
                    event.kind,
                    ticker,
                    cash=((pay, -event.amount),),
                    category=event.kind.lower(),
                    value=event.amount,
                    currency=pay,
                )
            )

    result.lots = {ticker: held for ticker, held in lots.items() if held}
    return result


def _charges(
    result: Replay, event: LedgerEvent, on: str, ticker: str, currency: str, *, tax_category: str
) -> None:
    """Report a trade's fee and tax as charges; their cash is already in the trade."""
    if event.fee:
        result.movements.append(
            Movement(on, event.key, event.kind, ticker, category="fee", value=event.fee, currency=currency)
        )
    if event.tax:
        result.movements.append(
            Movement(
                on, event.key, event.kind, ticker, category=tax_category, value=event.tax, currency=currency
            )
        )
