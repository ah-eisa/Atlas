"""SQLite persistence for the user's positions.

The analytics engine is pure: it receives a :class:`~backend.app.data.Portfolio`
and market data. This module is the only place that owns mutable state. Using
SQLite (rather than editing ``holdings.json`` by hand) gives the app atomic
writes, uniqueness constraints and a revision counter the analytics cache can
observe.

The ``holdings`` table models *current positions*: ticker, quantity, average
cost basis and earliest acquisition date. Orders placed through the trade
ledger also keep one row per purchase in ``lots``, so sales are matched FIFO
and each purchase keeps its own date. A position edited directly (the editor,
the CSV importer, the demo seed) no longer agrees with its lots; the next
order notices that and starts again from a single lot equal to the edited
position, rather than trading against a history that is no longer true.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import SETTINGS, Settings
from .data import CashFlow, Holding, Lot, Portfolio, normalise_currency

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holdings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name                TEXT NOT NULL,
    asset_class         TEXT NOT NULL,
    region              TEXT,
    currency            TEXT NOT NULL,
    quantity            REAL NOT NULL CHECK (quantity > 0),
    cost_basis_per_unit REAL NOT NULL CHECK (cost_basis_per_unit >= 0),
    acquired            TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_holdings_ticker ON holdings (ticker);

-- The cash-flow ledger: money the owner put in or took out, on a date.
-- Recorded flows replace the estimated flows derived from acquisition dates,
-- so the time-weighted return is measured against the real money.
CREATE TABLE IF NOT EXISTS cash_flows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_on TEXT NOT NULL,
    amount     REAL NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_cash_flows_date ON cash_flows (occurred_on);

-- The trade ledger: Buy and Sell orders with FIFO realized gain tracking.
CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL DEFAULT 1,
    ticker       TEXT NOT NULL COLLATE NOCASE,
    order_type   TEXT NOT NULL CHECK (order_type IN ('BUY', 'SELL')),
    quantity     REAL NOT NULL CHECK (quantity > 0),
    price        REAL NOT NULL CHECK (price >= 0),
    realized_pnl REAL NOT NULL DEFAULT 0.0,
    executed_at  TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_transactions_portfolio ON transactions (portfolio_id);
CREATE INDEX IF NOT EXISTS ix_transactions_date ON transactions (executed_at);

CREATE TABLE IF NOT EXISTS watchlist_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id      INTEGER NOT NULL DEFAULT 1,
    ticker            TEXT NOT NULL COLLATE NOCASE,
    name              TEXT NOT NULL DEFAULT '',
    target_buy_price  REAL,
    target_sell_price REAL,
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    UNIQUE(portfolio_id, ticker)
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL DEFAULT 1,
    metric       TEXT NOT NULL,
    ticker       TEXT,
    threshold    REAL NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL
);
"""


# ---------------------------------------------------------------------------
# Schema migrations
# ---------------------------------------------------------------------------
#
# `PRAGMA user_version` records the schema the database is on. Each entry in
# MIGRATIONS brings one version forward and is applied exactly once, in
# order. The base schema above is version 1; everything after it is a
# migration, so an existing database is never left behind a fresh one.
#
# A migration is a callable that receives the connection and is expected to
# be idempotent, because the version is only advanced after it succeeds.

MIGRATIONS: list[tuple[int, str, Any]] = [
    (
        2,
        "portfolios",
        lambda connection: _add_portfolio_dimension(connection),
    ),
    (
        3,
        "target_weights",
        lambda connection: _add_target_weight(connection),
    ),
    (
        4,
        "transactions",
        lambda connection: _add_transactions_table(connection),
    ),
    (
        5,
        "watchlist_and_alerts",
        lambda connection: _add_watchlist_and_alerts_tables(connection),
    ),
    (
        6,
        "tax_lots",
        lambda connection: _add_lot_tables(connection),
    ),
]


def _add_lot_tables(connection: sqlite3.Connection) -> None:
    """Track each purchase as its own lot, and which lots every sale consumed.

    ``lots`` is what makes FIFO real: a sale consumes the oldest lots first,
    and each lot keeps its own acquisition date. ``sell_allocations`` records
    exactly what a sale took from which lot, so deleting the sale can put it
    back. The holding snapshot on a sale lets a fully closed position be
    restored with its name, classification and target weight intact.
    """
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS lots (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id       INTEGER NOT NULL DEFAULT 1,
            ticker             TEXT NOT NULL COLLATE NOCASE,
            acquired           TEXT NOT NULL,
            quantity_original  REAL NOT NULL CHECK (quantity_original > 0),
            quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
            cost_per_unit      REAL NOT NULL CHECK (cost_per_unit >= 0),
            transaction_id     INTEGER,
            created_at         TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_lots_position ON lots (portfolio_id, ticker)"
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS sell_allocations (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_id INTEGER NOT NULL,
            lot_id         INTEGER NOT NULL,
            quantity       REAL NOT NULL CHECK (quantity > 0)
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_sell_allocations_tx ON sell_allocations (transaction_id)"
    )
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(transactions)").fetchall()
    }
    if "holding_snapshot" not in columns:
        connection.execute("ALTER TABLE transactions ADD COLUMN holding_snapshot TEXT")


def _add_watchlist_and_alerts_tables(connection: sqlite3.Connection) -> None:
    """Create watchlist_items and alert_rules tables."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS watchlist_items (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id      INTEGER NOT NULL DEFAULT 1,
            ticker            TEXT NOT NULL COLLATE NOCASE,
            name              TEXT NOT NULL DEFAULT '',
            target_buy_price  REAL,
            target_sell_price REAL,
            notes             TEXT NOT NULL DEFAULT '',
            created_at        TEXT NOT NULL,
            UNIQUE(portfolio_id, ticker)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_rules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL DEFAULT 1,
            metric       TEXT NOT NULL,
            ticker       TEXT,
            threshold    REAL NOT NULL,
            label        TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL
        )
        """
    )


def _add_transactions_table(connection: sqlite3.Connection) -> None:
    """Create the trade ledger transactions table."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS transactions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL DEFAULT 1,
            ticker       TEXT NOT NULL COLLATE NOCASE,
            order_type   TEXT NOT NULL CHECK (order_type IN ('BUY', 'SELL')),
            quantity     REAL NOT NULL CHECK (quantity > 0),
            price        REAL NOT NULL CHECK (price >= 0),
            realized_pnl REAL NOT NULL DEFAULT 0.0,
            executed_at  TEXT NOT NULL,
            notes        TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS ix_transactions_portfolio ON transactions (portfolio_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS ix_transactions_ticker ON transactions (ticker)")
    connection.execute("CREATE INDEX IF NOT EXISTS ix_transactions_date ON transactions (executed_at)")


def _add_target_weight(connection: sqlite3.Connection) -> None:
    """Add the optional target weight to a position.

    A target weight is what the owner *wants* to hold, as a fraction of the
    portfolio. It is optional: a portfolio without targets is a portfolio
    that has not decided what it is for, and the column stays null.
    """
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(holdings)").fetchall()
    }
    if "target_weight" not in columns:
        connection.execute("ALTER TABLE holdings ADD COLUMN target_weight REAL")


def _add_portfolio_dimension(connection: sqlite3.Connection) -> None:
    """Introduce the portfolio dimension for existing databases.

    A single-table database has no notion of a portfolio, so the rows are
    attributed to the default portfolio. The holdings table is rebuilt
    because its old uniqueness constraint was global on the ticker, and the
    same instrument must be allowed in two different portfolios; SQLite
    cannot drop an inline constraint, so the table is copied and swapped.
    """
    connection.execute(
        "CREATE TABLE IF NOT EXISTS portfolios ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " name TEXT NOT NULL,"
        " base_currency TEXT NOT NULL DEFAULT 'EUR',"
        " created_at TEXT NOT NULL)"
    )
    now = _now()
    connection.execute(
        "INSERT OR IGNORE INTO portfolios (id, name, base_currency, created_at) "
        "VALUES (1, 'Main', 'EUR', ?)",
        (now,),
    )

    holdings_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(holdings)").fetchall()
    }
    if "portfolio_id" not in holdings_columns:
        connection.execute(
            """
            CREATE TABLE holdings_v2 (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                portfolio_id        INTEGER NOT NULL DEFAULT 1,
                ticker              TEXT NOT NULL COLLATE NOCASE,
                name                TEXT NOT NULL,
                asset_class         TEXT NOT NULL,
                region              TEXT,
                currency            TEXT NOT NULL,
                quantity            REAL NOT NULL CHECK (quantity > 0),
                cost_basis_per_unit REAL NOT NULL CHECK (cost_basis_per_unit >= 0),
                acquired            TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL,
                UNIQUE (portfolio_id, ticker)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO holdings_v2
                (id, portfolio_id, ticker, name, asset_class, region, currency,
                 quantity, cost_basis_per_unit, acquired, created_at, updated_at)
            SELECT id, 1, ticker, name, asset_class, region, currency,
                   quantity, cost_basis_per_unit, acquired, created_at, updated_at
            FROM holdings
            """
        )
        connection.execute("DROP TABLE holdings")
        connection.execute("ALTER TABLE holdings_v2 RENAME TO holdings")

    flow_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(cash_flows)").fetchall()
    }
    if "portfolio_id" not in flow_columns:
        connection.execute(
            "ALTER TABLE cash_flows ADD COLUMN portfolio_id INTEGER NOT NULL DEFAULT 1"
        )

    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_holdings_portfolio ON holdings (portfolio_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_cash_flows_portfolio ON cash_flows (portfolio_id)"
    )


class StoreError(Exception):
    """Base class for storage failures the API can translate into a response."""


DEFAULT_PORTFOLIO_ID = 1


class DuplicateTicker(StoreError):
    """A position for that ticker already exists."""


class HoldingNotFound(StoreError):
    """No holding with the requested id."""


class EmptyPortfolio(StoreError):
    """Analytics were requested before any positions were added."""


class CashFlowNotFound(StoreError):
    """No cash flow with the requested id."""


class TransactionNotFound(StoreError):
    """No transaction with the requested id."""


class OrderValidationError(StoreError):
    """An order cannot be executed (e.g. selling more than owned)."""


class TransactionConflict(StoreError):
    """A transaction cannot be reversed without breaking a later one."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect(settings: Settings = SETTINGS) -> Iterator[sqlite3.Connection]:
    """Open a short-lived connection with sane pragmas.

    A connection per operation keeps the store safe under FastAPI's threadpool:
    SQLite connections are not meant to be shared across threads, and the write
    volume here is tiny.
    """
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.db_path, timeout=10.0)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db(settings: Settings = SETTINGS) -> None:
    with connect(settings) as connection:
        connection.executescript(SCHEMA)
        migrate(connection)
        if _get_meta(connection, "revision") is None:
            _set_meta(connection, "revision", "0")
        _ensure_default_portfolio(connection)


def migrate(connection: sqlite3.Connection) -> None:
    """Bring the database up to the latest schema version.

    The version lives in SQLite's ``user_version`` pragma, so it is stored
    with the data rather than beside it. Each migration is applied once, in
    order, and the version is only advanced after it succeeds - a failed
    migration leaves the database on the old version and is retried on the
    next start.
    """
    current = int(connection.execute("PRAGMA user_version").fetchone()[0])
    for version, name, apply in MIGRATIONS:
        if current >= version:
            continue
        logger.info("Applying schema migration %d (%s)", version, name)
        apply(connection)
        connection.execute(f"PRAGMA user_version = {version}")
        current = version


def _ensure_default_portfolio(connection: sqlite3.Connection) -> None:
    """Guarantee that the default portfolio exists."""
    row = connection.execute("SELECT id FROM portfolios WHERE id = 1").fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO portfolios (id, name, base_currency, created_at) "
            "VALUES (1, 'Main', 'EUR', ?)",
            (_now(),),
        )


def _get_meta(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row["value"])


def _set_meta(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _bump_revision(connection: sqlite3.Connection) -> None:
    current = int(_get_meta(connection, "revision") or 0)
    _set_meta(connection, "revision", str(current + 1))


def revision(settings: Settings = SETTINGS) -> int:
    """Monotonic counter bumped by every mutation, used to invalidate caches."""
    with connect(settings) as connection:
        return int(_get_meta(connection, "revision") or 0)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "ticker": str(row["ticker"]),
        "name": str(row["name"]),
        "asset_class": str(row["asset_class"]),
        "region": row["region"],
        "currency": str(row["currency"]),
        "quantity": float(row["quantity"]),
        "cost_basis_per_unit": float(row["cost_basis_per_unit"]),
        "acquired": str(row["acquired"]),
        "target_weight": (
            float(row["target_weight"]) if row["target_weight"] is not None else None
        ),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def _cash_flow_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Map a cash-flow row. Separate from the holdings mapper: the two
    tables do not share a shape, and one generic mapper would hide that."""
    return {
        "id": int(row["id"]),
        "occurred_on": str(row["occurred_on"]),
        "amount": float(row["amount"]),
        "note": str(row["note"]),
        "created_at": str(row["created_at"]),
    }


def _transaction_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Map a transaction row."""
    return {
        "id": int(row["id"]),
        "portfolio_id": int(row["portfolio_id"]),
        "ticker": str(row["ticker"]),
        "order_type": str(row["order_type"]),
        "quantity": float(row["quantity"]),
        "price": float(row["price"]),
        "realized_pnl": float(row["realized_pnl"]),
        "executed_at": str(row["executed_at"]),
        "notes": str(row["notes"]),
        "created_at": str(row["created_at"]),
    }


def delete_portfolio(portfolio_id: int, settings: Settings = SETTINGS) -> None:
    """Delete a portfolio and everything in it."""
    with connect(settings) as connection:
        cursor = connection.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))
        if cursor.rowcount == 0:
            raise StoreError(f"no portfolio with id {portfolio_id}")
        connection.execute("DELETE FROM holdings WHERE portfolio_id = ?", (portfolio_id,))
        connection.execute("DELETE FROM cash_flows WHERE portfolio_id = ?", (portfolio_id,))
        _bump_revision(connection)


def list_holdings(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY asset_class, ticker",
            (portfolio_id,),
        ).fetchall()
    return [_row_to_dict(row) for row in rows]


def get_holding(
    holding_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT * FROM holdings WHERE id = ? AND portfolio_id = ?",
            (holding_id, portfolio_id),
        ).fetchone()
    if row is None:
        raise HoldingNotFound(f"holding {holding_id} does not exist")
    return _row_to_dict(row)


def create_holding(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    now = _now()
    values = _normalise(data)
    with connect(settings) as connection:
        try:
            cursor = connection.execute(
                """
                INSERT INTO holdings
                    (portfolio_id, ticker, name, asset_class, region, currency, quantity,
                     cost_basis_per_unit, acquired, target_weight, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    portfolio_id,
                    values["ticker"],
                    values["name"],
                    values["asset_class"],
                    values["region"],
                    values["currency"],
                    values["quantity"],
                    values["cost_basis_per_unit"],
                    values["acquired"],
                    values["target_weight"],
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc).upper():
                raise DuplicateTicker(f"{values['ticker']} is already in the portfolio") from exc
            raise StoreError(str(exc)) from exc
        _bump_revision(connection)
        row = connection.execute("SELECT * FROM holdings WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _row_to_dict(row)


def update_holding(
    holding_id: int,
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    values = _normalise(data)
    with connect(settings) as connection:
        existing = connection.execute(
            "SELECT ticker FROM holdings WHERE id = ? AND portfolio_id = ?",
            (holding_id, portfolio_id),
        ).fetchone()
        if existing is None:
            raise HoldingNotFound(f"holding {holding_id} does not exist")
        try:
            connection.execute(
                """
                UPDATE holdings SET
                    ticker = ?, name = ?, asset_class = ?, region = ?, currency = ?,
                    quantity = ?, cost_basis_per_unit = ?, acquired = ?, target_weight = ?,
                    updated_at = ?
                WHERE id = ? AND portfolio_id = ?
                """,
                (
                    values["ticker"],
                    values["name"],
                    values["asset_class"],
                    values["region"],
                    values["currency"],
                    values["quantity"],
                    values["cost_basis_per_unit"],
                    values["acquired"],
                    values["target_weight"],
                    _now(),
                    holding_id,
                    portfolio_id,
                ),
            )
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc).upper():
                raise DuplicateTicker(f"{values['ticker']} is already in the portfolio") from exc
            raise StoreError(str(exc)) from exc
        _bump_revision(connection)
        row = connection.execute("SELECT * FROM holdings WHERE id = ?", (holding_id,)).fetchone()
    return _row_to_dict(row)


def delete_holding(
    holding_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    with connect(settings) as connection:
        cursor = connection.execute(
            "DELETE FROM holdings WHERE id = ? AND portfolio_id = ?", (holding_id, portfolio_id)
        )
        if cursor.rowcount == 0:
            raise HoldingNotFound(f"holding {holding_id} does not exist")
        _bump_revision(connection)


def _normalise(data: dict[str, Any]) -> dict[str, Any]:
    """Store a canonical currency code and strip display-only whitespace."""
    currency = str(data["currency"]).strip()
    # Keep the venue's convention for minor units (GBp), but upper-case majors.
    if currency in {"GBp", "ZAc", "ILA"}:
        stored_currency = currency
    else:
        stored_currency = normalise_currency(currency.upper())[0]
    return {
        "ticker": str(data["ticker"]).strip().upper(),
        "name": str(data["name"]).strip(),
        "asset_class": str(data["asset_class"]).strip(),
        "region": (str(data["region"]).strip() if data.get("region") else None),
        "currency": stored_currency,
        "quantity": float(data["quantity"]),
        "cost_basis_per_unit": float(data["cost_basis_per_unit"]),
        "acquired": str(data["acquired"]),
        "target_weight": (
            float(data["target_weight"])
            if data.get("target_weight") is not None
            else None
        ),
    }


def get_base_currency(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> str:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT base_currency FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
        if row is not None:
            return str(row["base_currency"]).upper()
        # A database created before the portfolio dimension keeps its
        # currency in the meta table.
        value = _get_meta(connection, "base_currency")
    return (value or settings.base_currency).upper()


def set_base_currency(
    currency: str,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> str:
    code = currency.strip().upper()
    if len(code) != 3 or not code.isalpha():
        raise ValueError("base currency must be a three-letter ISO code")
    with connect(settings) as connection:
        _ensure_default_portfolio(connection)
        connection.execute(
            "UPDATE portfolios SET base_currency = ? WHERE id = ?", (code, portfolio_id)
        )
        if connection.total_changes == 0:
            connection.execute(
                "INSERT INTO portfolios (id, name, base_currency, created_at) "
                "VALUES (?, 'Main', ?, ?)",
                (portfolio_id, code, _now()),
            )
        _bump_revision(connection)
    return code


# ---------------------------------------------------------------------------
# Portfolios
# ---------------------------------------------------------------------------


def list_portfolios(settings: Settings = SETTINGS) -> list[dict[str, Any]]:
    """Every tracked portfolio, oldest first."""
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT id, name, base_currency, created_at FROM portfolios ORDER BY id"
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "base_currency": str(row["base_currency"]).upper(),
            "created_at": str(row["created_at"]),
        }
        for row in rows
    ]


def create_portfolio(
    name: str,
    base_currency: str = "",
    settings: Settings = SETTINGS,
) -> dict[str, Any]:
    """Create a portfolio. Its currency defaults to the default portfolio's."""
    label = name.strip() or "Portfolio"
    code = base_currency.strip().upper()
    if not code:
        code = get_base_currency(settings)
    if len(code) != 3 or not code.isalpha():
        raise ValueError("base currency must be a three-letter ISO code")
    with connect(settings) as connection:
        cursor = connection.execute(
            "INSERT INTO portfolios (name, base_currency, created_at) VALUES (?, ?, ?)",
            (label, code, _now()),
        )
        _bump_revision(connection)
        row = connection.execute(
            "SELECT id, name, base_currency, created_at FROM portfolios WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "base_currency": str(row["base_currency"]).upper(),
        "created_at": str(row["created_at"]),
    }


def position_lots(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, tuple[Lot, ...]]:
    """Open lots per ticker, for the positions whose lots still describe them.

    A position edited by hand since its last order is left out: its lots no
    longer add up to it, and the analytics fall back to its acquisition date.
    """
    result: dict[str, tuple[Lot, ...]] = {}
    with connect(settings) as connection:
        # A database that has not been migrated yet (read by a script before
        # the API has started) has no lots, and its positions need none.
        has_lots = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lots'"
        ).fetchone()
        if has_lots is None:
            return result
        holdings = connection.execute(
            "SELECT * FROM holdings WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchall()
        for holding in holdings:
            ticker = str(holding["ticker"])
            open_lots = _open_lots(connection, portfolio_id, ticker)
            if open_lots and _lots_match_holding(open_lots, holding):
                result[ticker.upper()] = tuple(
                    Lot(acquired=str(lot["acquired"]), quantity=float(lot["quantity_remaining"]))
                    for lot in open_lots
                )
    return result


def build_portfolio(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> Portfolio:
    """Materialise the stored rows into the domain object analytics consume."""
    rows = list_holdings(settings, portfolio_id)
    if not rows:
        raise EmptyPortfolio("the portfolio has no positions")
    lots = position_lots(settings, portfolio_id)
    holdings = tuple(
        Holding(
            ticker=row["ticker"],
            name=row["name"],
            asset_class=row["asset_class"],
            region=row["region"],
            currency=row["currency"],
            quantity=row["quantity"],
            cost_basis_per_unit=row["cost_basis_per_unit"],
            acquired=row["acquired"],
            target_weight=(
                float(row["target_weight"]) if row["target_weight"] is not None else None
            ),
            lots=lots.get(row["ticker"].upper(), ()),
        )
        for row in rows
    )
    cash_flows = tuple(
        CashFlow(
            occurred_on=row["occurred_on"],
            amount=row["amount"],
            note=row["note"],
        )
        for row in list_cash_flows(settings, portfolio_id)
    )
    return Portfolio(
        base_currency=get_base_currency(settings, portfolio_id),
        holdings=holdings,
        cash_flows=cash_flows,
    )


# ---------------------------------------------------------------------------
# Cash flows
# ---------------------------------------------------------------------------


def list_cash_flows(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    """Every recorded contribution and withdrawal, oldest first."""
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT id, occurred_on, amount, note, created_at "
            "FROM cash_flows WHERE portfolio_id = ? ORDER BY occurred_on, id",
            (portfolio_id,),
        ).fetchall()
    return [_cash_flow_row_to_dict(row) for row in rows]


def create_cash_flow(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    """Record one external contribution (positive) or withdrawal (negative)."""
    occurred_on = str(data["occurred_on"]).strip()
    amount = float(data["amount"])
    note = str(data.get("note", "")).strip()
    with connect(settings) as connection:
        cursor = connection.execute(
            "INSERT INTO cash_flows (portfolio_id, occurred_on, amount, note, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (portfolio_id, occurred_on, amount, note, _now()),
        )
        _bump_revision(connection)
        row = connection.execute(
            "SELECT id, occurred_on, amount, note, created_at FROM cash_flows WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return _cash_flow_row_to_dict(row)


def delete_cash_flow(
    cash_flow_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Remove a recorded cash flow."""
    with connect(settings) as connection:
        cursor = connection.execute(
            "DELETE FROM cash_flows WHERE id = ? AND portfolio_id = ?",
            (cash_flow_id, portfolio_id),
        )
        if cursor.rowcount == 0:
            raise CashFlowNotFound(f"no cash flow with id {cash_flow_id}")
        _bump_revision(connection)


# ---------------------------------------------------------------------------
# Trade Ledger & FIFO Transactions
# ---------------------------------------------------------------------------


def list_transactions(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    """Every executed Buy/Sell order for this portfolio, newest first."""
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT id, portfolio_id, ticker, order_type, quantity, price,
                   realized_pnl, executed_at, notes, created_at
            FROM transactions
            WHERE portfolio_id = ?
            ORDER BY executed_at DESC, id DESC
            """,
            (portfolio_id,),
        ).fetchall()
    return [_transaction_row_to_dict(row) for row in rows]


# Quantities below this are treated as zero, so floating-point residue from a
# sale never leaves a dust position behind.
_QTY_EPS = 1e-6


def _holding_row(
    connection: sqlite3.Connection, portfolio_id: int, ticker: str
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM holdings WHERE portfolio_id = ? AND ticker = ? COLLATE NOCASE",
        (portfolio_id, ticker),
    ).fetchone()


def _open_lots(
    connection: sqlite3.Connection, portfolio_id: int, ticker: str
) -> list[sqlite3.Row]:
    """Lots with units left, oldest first: the order a FIFO sale consumes them."""
    return connection.execute(
        """
        SELECT * FROM lots
        WHERE portfolio_id = ? AND ticker = ? COLLATE NOCASE AND quantity_remaining > ?
        ORDER BY acquired, id
        """,
        (portfolio_id, ticker, _QTY_EPS),
    ).fetchall()


def _lots_summary(lots: list[sqlite3.Row]) -> tuple[float, float, str | None]:
    """Total units, average cost per unit and earliest acquisition of some lots."""
    quantity = sum(float(lot["quantity_remaining"]) for lot in lots)
    if quantity <= _QTY_EPS:
        return 0.0, 0.0, None
    cost = sum(float(lot["quantity_remaining"]) * float(lot["cost_per_unit"]) for lot in lots)
    return quantity, cost / quantity, min(str(lot["acquired"]) for lot in lots)


def _lots_match_holding(lots: list[sqlite3.Row], holding: sqlite3.Row | None) -> bool:
    """Whether the lots still describe the stored position exactly."""
    if holding is None:
        return not lots
    quantity, cost, earliest = _lots_summary(lots)
    held = float(holding["quantity"])
    basis = float(holding["cost_basis_per_unit"])
    return (
        abs(quantity - held) <= _QTY_EPS * max(1.0, held)
        and abs(cost - basis) <= 1e-9 * max(1.0, abs(basis))
        and earliest == str(holding["acquired"])[:10]
    )


def _reconcile_lots(
    connection: sqlite3.Connection,
    portfolio_id: int,
    ticker: str,
    holding: sqlite3.Row | None,
) -> list[sqlite3.Row]:
    """The open lots of a position, rebuilt from the position when they disagree.

    A position edited outside the ledger is the truth; its old lots are not.
    They are replaced by one lot equal to the position, which also means the
    orders placed before the edit can no longer be reversed lot by lot.
    """
    lots = _open_lots(connection, portfolio_id, ticker)
    if _lots_match_holding(lots, holding):
        return lots
    connection.execute(
        "DELETE FROM lots WHERE portfolio_id = ? AND ticker = ? COLLATE NOCASE",
        (portfolio_id, ticker),
    )
    if holding is None:
        return []
    quantity = float(holding["quantity"])
    connection.execute(
        """
        INSERT INTO lots (
            portfolio_id, ticker, acquired, quantity_original, quantity_remaining,
            cost_per_unit, transaction_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
        """,
        (
            portfolio_id,
            str(holding["ticker"]),
            str(holding["acquired"])[:10],
            quantity,
            quantity,
            float(holding["cost_basis_per_unit"]),
            _now(),
        ),
    )
    return _open_lots(connection, portfolio_id, ticker)


def _holding_metadata(holding: sqlite3.Row) -> dict[str, Any]:
    """What a position is, apart from how much of it is held."""
    return {
        "name": str(holding["name"]),
        "asset_class": str(holding["asset_class"]),
        "region": holding["region"],
        "currency": str(holding["currency"]),
        "target_weight": holding["target_weight"],
    }


def _instrument_metadata(ticker: str) -> dict[str, Any]:
    """Describe a ticker bought for the first time, from the instrument lookup."""
    try:
        from .instruments import lookup

        inst = lookup(ticker)
        return {
            "name": inst.name or ticker,
            "asset_class": inst.asset_class or "Stock",
            "region": inst.region,
            "currency": inst.currency or "USD",
            "target_weight": None,
        }
    except Exception:  # noqa: BLE001 - an offline lookup must not block the order
        return {
            "name": ticker,
            "asset_class": "Stock",
            "region": None,
            "currency": "USD",
            "target_weight": None,
        }


def _sync_holding(
    connection: sqlite3.Connection,
    portfolio_id: int,
    ticker: str,
    holding: sqlite3.Row | None,
    metadata: dict[str, Any] | None,
) -> None:
    """Write the position the open lots now add up to (or remove it)."""
    quantity, cost, earliest = _lots_summary(_open_lots(connection, portfolio_id, ticker))
    now = _now()
    if quantity <= _QTY_EPS:
        if holding is not None:
            connection.execute("DELETE FROM holdings WHERE id = ?", (holding["id"],))
        return
    if holding is not None:
        connection.execute(
            """
            UPDATE holdings
            SET quantity = ?, cost_basis_per_unit = ?, acquired = ?, updated_at = ?
            WHERE id = ?
            """,
            (quantity, cost, earliest, now, holding["id"]),
        )
        return
    meta = metadata or _instrument_metadata(ticker)
    connection.execute(
        """
        INSERT INTO holdings (
            portfolio_id, ticker, name, asset_class, region, currency,
            quantity, cost_basis_per_unit, acquired, target_weight,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            portfolio_id,
            ticker,
            meta["name"],
            meta["asset_class"],
            meta["region"],
            meta["currency"],
            quantity,
            cost,
            earliest,
            meta["target_weight"],
            now,
            now,
        ),
    )


def place_order(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    """Execute a Buy or Sell order with FIFO lot matching and update portfolio positions.

    A buy opens a new lot dated on its execution day. A sell consumes the
    oldest lots that were already held on its execution day, and its realized
    P&L is measured against the cost of exactly those lots.
    """
    ticker_clean = str(data["ticker"]).strip().upper()
    order_type_clean = str(data["order_type"]).strip().upper()
    quantity = float(data["quantity"])
    price = float(data["price"])
    executed_at = str(data["executed_at"])
    executed_on = executed_at[:10]
    notes = str(data.get("notes", "")).strip()

    if quantity <= 0:
        raise OrderValidationError("Order quantity must be positive")
    if price < 0:
        raise OrderValidationError("Order price must be non-negative")
    if order_type_clean not in ("BUY", "SELL"):
        raise OrderValidationError(f"Invalid order type: {order_type_clean}")

    now = _now()

    with connect(settings) as connection:
        holding = _holding_row(connection, portfolio_id, ticker_clean)
        lots = _reconcile_lots(connection, portfolio_id, ticker_clean, holding)

        realized_pnl = 0.0
        allocations: list[tuple[int, float, float]] = []
        snapshot: str | None = None
        metadata: dict[str, Any] | None = None

        if order_type_clean == "BUY":
            if holding is None:
                metadata = _instrument_metadata(ticker_clean)
        else:
            if holding is None:
                raise OrderValidationError(f"Cannot sell {ticker_clean}: no position in portfolio")
            current_qty = float(holding["quantity"])
            if current_qty + _QTY_EPS < quantity:
                raise OrderValidationError(
                    f"Cannot sell {quantity} shares of {ticker_clean}: only {current_qty} held"
                )
            eligible = [lot for lot in lots if str(lot["acquired"]) <= executed_on]
            available = sum(float(lot["quantity_remaining"]) for lot in eligible)
            if available + _QTY_EPS < quantity:
                raise OrderValidationError(
                    f"Cannot sell {quantity} shares of {ticker_clean} on {executed_on}: "
                    f"only {available} held on that date"
                )
            to_sell = quantity
            for lot in eligible:
                if to_sell <= _QTY_EPS:
                    break
                remaining = float(lot["quantity_remaining"])
                take = min(remaining, to_sell)
                realized_pnl += (price - float(lot["cost_per_unit"])) * take
                left = remaining - take
                allocations.append((int(lot["id"]), take, 0.0 if left <= _QTY_EPS else left))
                to_sell -= take
            snapshot = json.dumps(_holding_metadata(holding))

        cursor = connection.execute(
            """
            INSERT INTO transactions (
                portfolio_id, ticker, order_type, quantity, price,
                realized_pnl, executed_at, notes, created_at, holding_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                portfolio_id,
                ticker_clean,
                order_type_clean,
                quantity,
                price,
                realized_pnl,
                executed_at,
                notes,
                now,
                snapshot,
            ),
        )
        tx_id = cursor.lastrowid

        if order_type_clean == "BUY":
            connection.execute(
                """
                INSERT INTO lots (
                    portfolio_id, ticker, acquired, quantity_original, quantity_remaining,
                    cost_per_unit, transaction_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (portfolio_id, ticker_clean, executed_on, quantity, quantity, price, tx_id, now),
            )
        else:
            for lot_id, take, left in allocations:
                connection.execute(
                    "UPDATE lots SET quantity_remaining = ? WHERE id = ?", (left, lot_id)
                )
                connection.execute(
                    "INSERT INTO sell_allocations (transaction_id, lot_id, quantity) "
                    "VALUES (?, ?, ?)",
                    (tx_id, lot_id, take),
                )

        _sync_holding(connection, portfolio_id, ticker_clean, holding, metadata)
        _bump_revision(connection)

        tx_row = connection.execute(
            "SELECT id, portfolio_id, ticker, order_type, quantity, price, realized_pnl, executed_at, notes, created_at "
            "FROM transactions WHERE id = ?",
            (tx_id,),
        ).fetchone()

    return _transaction_row_to_dict(tx_row)


def delete_transaction(
    transaction_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Delete a recorded transaction and reverse its effect on the position.

    Deleting a buy removes its lot, which is refused while a later sale has
    consumed part of it. Deleting a sale returns the units to the lots it
    took them from, reopening the position if the sale had closed it.

    When the position has been edited by hand since the order (or the order
    predates lot tracking), the edited position is kept as it is and only the
    ledger record is removed.
    """
    with connect(settings) as connection:
        tx = connection.execute(
            "SELECT * FROM transactions WHERE id = ? AND portfolio_id = ?",
            (transaction_id, portfolio_id),
        ).fetchone()
        if tx is None:
            raise TransactionNotFound(f"no transaction with id {transaction_id}")

        ticker = str(tx["ticker"])
        holding = _holding_row(connection, portfolio_id, ticker)
        in_step = _lots_match_holding(_open_lots(connection, portfolio_id, ticker), holding)
        reversed_position = False
        metadata: dict[str, Any] | None = None

        if tx["order_type"] == "BUY":
            lot = connection.execute(
                "SELECT * FROM lots WHERE transaction_id = ?", (transaction_id,)
            ).fetchone()
            if in_step and lot is not None:
                if float(lot["quantity_remaining"]) + _QTY_EPS < float(lot["quantity_original"]):
                    raise TransactionConflict(
                        f"units from this purchase of {ticker} were sold by a later order; "
                        "delete that sale first"
                    )
                connection.execute("DELETE FROM lots WHERE id = ?", (lot["id"],))
                reversed_position = True
        else:
            allocations = connection.execute(
                "SELECT lot_id, quantity FROM sell_allocations WHERE transaction_id = ?",
                (transaction_id,),
            ).fetchall()
            lot_ids = [int(a["lot_id"]) for a in allocations]
            found = (
                connection.execute(
                    f"SELECT COUNT(*) FROM lots WHERE id IN ({','.join('?' * len(lot_ids))})",
                    lot_ids,
                ).fetchone()[0]
                if lot_ids
                else 0
            )
            if in_step and allocations and found == len(set(lot_ids)):
                for allocation in allocations:
                    connection.execute(
                        "UPDATE lots SET quantity_remaining = quantity_remaining + ? WHERE id = ?",
                        (float(allocation["quantity"]), int(allocation["lot_id"])),
                    )
                if holding is None and tx["holding_snapshot"]:
                    metadata = json.loads(tx["holding_snapshot"])
                reversed_position = True
            connection.execute(
                "DELETE FROM sell_allocations WHERE transaction_id = ?", (transaction_id,)
            )

        connection.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
        if reversed_position:
            _sync_holding(connection, portfolio_id, ticker, holding, metadata)
        else:
            logger.info(
                "Transaction %d removed from the ledger only: the %s position was "
                "edited after it, so the edited position is kept",
                transaction_id,
                ticker,
            )
        _bump_revision(connection)


def get_realized_pnl_summary(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, Any]:
    """Calculate realized P&L, win/loss stats and trade volume."""
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT order_type, quantity, price, realized_pnl
            FROM transactions
            WHERE portfolio_id = ?
            """,
            (portfolio_id,),
        ).fetchall()

    total_realized_pnl = sum(float(r["realized_pnl"]) for r in rows if r["order_type"] == "SELL")
    total_buys = sum(1 for r in rows if r["order_type"] == "BUY")
    total_sells = sum(1 for r in rows if r["order_type"] == "SELL")
    winning_trades = sum(1 for r in rows if r["order_type"] == "SELL" and float(r["realized_pnl"]) > 0)
    losing_trades = sum(1 for r in rows if r["order_type"] == "SELL" and float(r["realized_pnl"]) < 0)
    total_buy_volume = sum(float(r["quantity"]) * float(r["price"]) for r in rows if r["order_type"] == "BUY")
    total_sell_volume = sum(float(r["quantity"]) * float(r["price"]) for r in rows if r["order_type"] == "SELL")
    win_rate_pct = (winning_trades / total_sells) if total_sells > 0 else None

    return {
        "total_realized_pnl": round(total_realized_pnl, 2),
        "total_trades": len(rows),
        "total_buys": total_buys,
        "total_sells": total_sells,
        "winning_trades": winning_trades,
        "losing_trades": losing_trades,
        "win_rate_pct": win_rate_pct,
        "total_buy_volume": round(total_buy_volume, 2),
        "total_sell_volume": round(total_sell_volume, 2),
    }


def seed_from_demo(settings: Settings = SETTINGS) -> int:
    """Import ``holdings.json`` once, on first boot, into an empty store.

    The marker lives in ``meta`` rather than being inferred from an empty table,
    so deleting every position on purpose does not cause the demo to reappear on
    the next restart.
    """
    with connect(settings) as connection:
        if _get_meta(connection, "seeded") is not None:
            return 0
        if not settings.seed_demo or not settings.holdings_path.exists():
            _set_meta(connection, "seeded", "0")
            return 0
        try:
            raw = json.loads(settings.holdings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Could not read demo holdings %s: %s", settings.holdings_path, exc)
            _set_meta(connection, "seeded", "0")
            return 0

        base_currency = str(raw.get("base_currency", settings.base_currency)).upper()
        _ensure_default_portfolio(connection)
        connection.execute(
            "UPDATE portfolios SET base_currency = ? WHERE id = ?",
            (base_currency, DEFAULT_PORTFOLIO_ID),
        )

        imported = 0
        now = _now()
        for item in raw.get("holdings", []):
            try:
                values = _normalise(
                    {
                        "ticker": item["ticker"],
                        "name": item["name"],
                        "asset_class": item["asset_class"],
                        "region": item.get("region"),
                        "currency": item["currency"],
                        "quantity": item["quantity"],
                        "cost_basis_per_unit": item["cost_basis_per_unit"],
                        "acquired": item["acquired"],
                    }
                )
            except (KeyError, TypeError, ValueError) as exc:
                logger.warning("Skipping invalid demo holding %s: %s", item, exc)
                continue
            connection.execute(
                """
                INSERT OR IGNORE INTO holdings
                    (portfolio_id, ticker, name, asset_class, region, currency, quantity,
                     cost_basis_per_unit, acquired, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    DEFAULT_PORTFOLIO_ID,
                    values["ticker"],
                    values["name"],
                    values["asset_class"],
                    values["region"],
                    values["currency"],
                    values["quantity"],
                    values["cost_basis_per_unit"],
                    values["acquired"],
                    now,
                    now,
                ),
            )
            imported += 1
        _set_meta(connection, "seeded", "1")
        _bump_revision(connection)
        logger.info("Seeded %d demo positions from %s", imported, settings.holdings_path)
        return imported


def replace_all(
    rows: list[dict[str, Any]],
    base_currency: str,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> int:
    """Replace every stored position, atomically.

    Used by the interactive/CSV importer. Validation has already happened in
    the importer; the store still enforces the database constraints.
    """
    now = _now()
    normalised = [_normalise(row) for row in rows]
    with connect(settings) as connection:
        connection.execute("DELETE FROM holdings WHERE portfolio_id = ?", (portfolio_id,))
        for values in normalised:
            connection.execute(
                """
                INSERT INTO holdings
                    (portfolio_id, ticker, name, asset_class, region, currency, quantity,
                     cost_basis_per_unit, acquired, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    portfolio_id,
                    values["ticker"],
                    values["name"],
                    values["asset_class"],
                    values["region"],
                    values["currency"],
                    values["quantity"],
                    values["cost_basis_per_unit"],
                    values["acquired"],
                    now,
                    now,
                ),
            )
        _ensure_default_portfolio(connection)
        connection.execute(
            "UPDATE portfolios SET base_currency = ? WHERE id = ?",
            (base_currency.strip().upper(), portfolio_id),
        )
        _set_meta(connection, "seeded", "1")
        _bump_revision(connection)
    return len(normalised)


def export_rows(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    """Holdings without storage metadata, suitable for CSV/JSON export."""
    fields = (
        "ticker", "name", "asset_class", "region", "currency",
        "quantity", "cost_basis_per_unit", "acquired",
    )
    return [
        {key: row[key] for key in fields}
        for row in list_holdings(settings, portfolio_id)
    ]


def is_empty(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> bool:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS n FROM holdings WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchone()
    return int(row["n"]) == 0


# ---------------------------------------------------------------------------
# Watchlist & Smart Alerts Persistence
# ---------------------------------------------------------------------------


def list_watchlist(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT id, portfolio_id, ticker, name, target_buy_price, target_sell_price, notes, created_at
            FROM watchlist_items
            WHERE portfolio_id = ?
            ORDER BY ticker ASC
            """,
            (portfolio_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_watchlist_item(
    payload: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    ticker = str(payload.get("ticker", "")).strip().upper()
    if not ticker or len(ticker) > 20:
        raise ValueError("Invalid ticker symbol")
    name = str(payload.get("name") or ticker).strip()
    target_buy = payload.get("target_buy_price")
    target_sell = payload.get("target_sell_price")
    notes = str(payload.get("notes") or "").strip()
    now = _now()

    with connect(settings) as connection:
        connection.execute(
            """
            INSERT INTO watchlist_items
                (portfolio_id, ticker, name, target_buy_price, target_sell_price, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
                name = excluded.name,
                target_buy_price = excluded.target_buy_price,
                target_sell_price = excluded.target_sell_price,
                notes = excluded.notes
            """,
            (
                portfolio_id,
                ticker,
                name,
                float(target_buy) if target_buy is not None else None,
                float(target_sell) if target_sell is not None else None,
                notes,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT id, portfolio_id, ticker, name, target_buy_price, target_sell_price, notes, created_at
            FROM watchlist_items
            WHERE portfolio_id = ? AND ticker = ?
            """,
            (portfolio_id, ticker),
        ).fetchone()
    return dict(row)


def delete_watchlist_item(
    item_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    with connect(settings) as connection:
        connection.execute(
            "DELETE FROM watchlist_items WHERE id = ? AND portfolio_id = ?",
            (item_id, portfolio_id),
        )


def list_alert_rules(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT id, portfolio_id, metric, ticker, threshold, label, enabled, created_at
            FROM alert_rules
            WHERE portfolio_id = ?
            ORDER BY id DESC
            """,
            (portfolio_id,),
        ).fetchall()
    return [{**dict(r), "enabled": bool(r["enabled"])} for r in rows]


def create_alert_rule(
    payload: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    metric = str(payload.get("metric", "")).strip()
    allowed_metrics = {
        "price_above",
        "price_below",
        "drawdown_pct",
        "var_95_pct",
        "position_weight_pct",
        "yield_10y_above",
    }
    if metric not in allowed_metrics:
        raise ValueError(f"metric must be one of {sorted(allowed_metrics)}")
    ticker = str(payload.get("ticker") or "").strip().upper() or None
    threshold = float(payload["threshold"])
    label = str(payload.get("label") or f"{metric} ({threshold})").strip()
    now = _now()

    with connect(settings) as connection:
        cursor = connection.execute(
            """
            INSERT INTO alert_rules
                (portfolio_id, metric, ticker, threshold, label, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            """,
            (portfolio_id, metric, ticker, threshold, label, now),
        )
        row = connection.execute(
            "SELECT id, portfolio_id, metric, ticker, threshold, label, enabled, created_at FROM alert_rules WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return {**dict(row), "enabled": bool(row["enabled"])}


def delete_alert_rule(
    rule_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    with connect(settings) as connection:
        connection.execute(
            "DELETE FROM alert_rules WHERE id = ? AND portfolio_id = ?",
            (rule_id, portfolio_id),
        )


__all__ = [
    "DEFAULT_PORTFOLIO_ID",
    "CashFlowNotFound",
    "DuplicateTicker",
    "EmptyPortfolio",
    "HoldingNotFound",
    "StoreError",
    "TransactionNotFound",
    "OrderValidationError",
    "list_transactions",
    "place_order",
    "delete_transaction",
    "get_realized_pnl_summary",
    "build_portfolio",
    "create_cash_flow",
    "create_holding",
    "create_portfolio",
    "delete_cash_flow",
    "delete_holding",
    "export_rows",
    "get_base_currency",
    "get_holding",
    "init_db",
    "is_empty",
    "list_cash_flows",
    "list_holdings",
    "list_portfolios",
    "migrate",
    "replace_all",
    "revision",
    "seed_from_demo",
    "set_base_currency",
    "update_holding",
]
