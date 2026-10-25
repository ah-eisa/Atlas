"""SQLite persistence for the user's positions.

The analytics engine is pure: it receives a :class:`~backend.app.data.Portfolio`
and market data. This module is the only place that owns mutable state. Using
SQLite (rather than editing ``holdings.json`` by hand) gives the app atomic
writes, uniqueness constraints and a revision counter the analytics cache can
observe.

The ``holdings`` table models *current positions*: ticker, quantity, average
cost basis and earliest acquisition date. They are derived: every change is
an event - a trade in ``transactions``; a dividend, fee, tax, corporate
action, currency conversion or hand edit in ``ledger_events``; a deposit or
withdrawal in ``cash_flows`` - and the positions, their FIFO ``lots`` and the
realised result of every sale are rebuilt by replaying the events (see
``ledger.py``). A position edited directly (the editor, the CSV importer, the
demo seed) is recorded as an ``ADJUSTMENT`` event: from then on it is the
truth for its ticker, and the unit events recorded before it stop applying.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from . import audit, ledger
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
    (
        7,
        "ledger_events",
        lambda connection: _add_ledger_events(connection),
    ),
    (
        8,
        "governance",
        lambda connection: _add_governance_tables(connection),
    ),
]


def _add_governance_tables(connection: sqlite3.Connection) -> None:
    """The mandate around a portfolio, and the record of who changed what.

    * ``portfolios.benchmark_policy``: the blended benchmark the portfolio is
      measured against, as JSON; ``portfolios.model_id``: the model portfolio
      it follows.
    * ``models`` and ``model_weights``: model portfolios, shared by every
      portfolio, as target weights per instrument.
    * ``sleeves``: named parts of a portfolio with their own target weight;
      ``holdings.sleeve_id`` puts a position in one.
    * ``compliance_rules``: the limits a portfolio must stay within.
    * ``audit_log``: every change, append-only. Each entry carries the hash
      of the one before it, so an edited or deleted entry breaks the chain;
      triggers refuse updates and deletes outright.
    * ``report_schedules`` and ``report_runs``: reports written on a schedule.
    """
    portfolio_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(portfolios)").fetchall()
    }
    if "benchmark_policy" not in portfolio_columns:
        connection.execute("ALTER TABLE portfolios ADD COLUMN benchmark_policy TEXT")
    if "model_id" not in portfolio_columns:
        connection.execute("ALTER TABLE portfolios ADD COLUMN model_id INTEGER")
    holding_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(holdings)").fetchall()
    }
    if "sleeve_id" not in holding_columns:
        connection.execute("ALTER TABLE holdings ADD COLUMN sleeve_id INTEGER")

    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS models (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_weights (
            model_id INTEGER NOT NULL,
            ticker   TEXT NOT NULL COLLATE NOCASE,
            weight   REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
            PRIMARY KEY (model_id, ticker)
        );
        CREATE TABLE IF NOT EXISTS sleeves (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id  INTEGER NOT NULL DEFAULT 1,
            name          TEXT NOT NULL,
            target_weight REAL CHECK (target_weight IS NULL OR (target_weight >= 0 AND target_weight <= 1)),
            description   TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            UNIQUE (portfolio_id, name)
        );
        CREATE TABLE IF NOT EXISTS compliance_rules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL DEFAULT 1,
            kind         TEXT NOT NULL,
            subject      TEXT,
            limit_value  REAL,
            severity     TEXT NOT NULL DEFAULT 'breach',
            enabled      INTEGER NOT NULL DEFAULT 1,
            note         TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER,
            at           TEXT NOT NULL,
            actor        TEXT NOT NULL,
            action       TEXT NOT NULL,
            entity       TEXT NOT NULL,
            entity_id    TEXT,
            detail       TEXT NOT NULL DEFAULT '{}',
            prev_hash    TEXT NOT NULL,
            hash         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_audit_portfolio ON audit_log (portfolio_id, id);
        CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
        CREATE TABLE IF NOT EXISTS report_schedules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id INTEGER NOT NULL DEFAULT 1,
            name         TEXT NOT NULL,
            frequency    TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
            weekday      INTEGER NOT NULL DEFAULT 0,
            monthday     INTEGER NOT NULL DEFAULT 1,
            hour         INTEGER NOT NULL DEFAULT 7,
            enabled      INTEGER NOT NULL DEFAULT 1,
            last_run_at  TEXT,
            next_run_at  TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id  INTEGER,
            portfolio_id INTEGER NOT NULL,
            started_at   TEXT NOT NULL,
            finished_at  TEXT,
            status       TEXT NOT NULL,
            path         TEXT,
            error        TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_report_runs_schedule ON report_runs (schedule_id, id);
        """
    )


def _add_ledger_events(connection: sqlite3.Connection) -> None:
    """Make the ledger the one source positions are rebuilt from.

    Trades gain a fee, a tax, their currency and a place in the recording
    order. Every other event - dividends, fees, taxes, corporate actions,
    currency conversions and hand edits of a position - goes in
    ``ledger_events``. A synthetic lot from an earlier version (a position
    edited by hand and reconciled at the next order) becomes the
    ``ADJUSTMENT`` it stood for, in the place it took in the recording order.
    Any position the events still do not describe is then recorded as an
    adjustment too, so every position is rebuilt from its events from here on.
    """
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(transactions)").fetchall()
    }
    for name, ddl in (
        ("fee", "ALTER TABLE transactions ADD COLUMN fee REAL NOT NULL DEFAULT 0"),
        ("tax", "ALTER TABLE transactions ADD COLUMN tax REAL NOT NULL DEFAULT 0"),
        ("currency", "ALTER TABLE transactions ADD COLUMN currency TEXT"),
        ("seq", "ALTER TABLE transactions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0"),
        ("holding_snapshot", "ALTER TABLE transactions ADD COLUMN holding_snapshot TEXT"),
    ):
        if name not in columns:
            connection.execute(ddl)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            portfolio_id  INTEGER NOT NULL DEFAULT 1,
            kind          TEXT NOT NULL,
            occurred_on   TEXT NOT NULL,
            ticker        TEXT COLLATE NOCASE,
            quantity      REAL NOT NULL DEFAULT 0,
            price         REAL NOT NULL DEFAULT 0,
            amount        REAL NOT NULL DEFAULT 0,
            currency      TEXT,
            fee           REAL NOT NULL DEFAULT 0,
            tax           REAL NOT NULL DEFAULT 0,
            ratio         REAL,
            new_ticker    TEXT COLLATE NOCASE,
            cost_fraction REAL NOT NULL DEFAULT 0,
            to_currency   TEXT,
            to_amount     REAL NOT NULL DEFAULT 0,
            note          TEXT NOT NULL DEFAULT '',
            seq           INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_ledger_events_portfolio ON ledger_events (portfolio_id)"
    )

    # The recording order: trades by when they were made, and each synthetic
    # lot just before the order that reconciled it - the last order of its
    # ticker made in the same second, or else the next one after it.
    trades = sorted(
        connection.execute("SELECT * FROM transactions").fetchall(),
        key=lambda row: (str(row["created_at"]), int(row["id"])),
    )
    entries: list[tuple[int, sqlite3.Row]] = [(1, row) for row in trades]
    if _has_table(connection, "lots"):
        for lot in connection.execute(
            "SELECT * FROM lots WHERE transaction_id IS NULL ORDER BY id"
        ).fetchall():
            same = [
                index
                for index, (is_trade, row) in enumerate(entries)
                if is_trade
                and int(row["portfolio_id"]) == int(lot["portfolio_id"])
                and str(row["ticker"]).upper() == str(lot["ticker"]).upper()
            ]
            tied = [i for i in same if str(entries[i][1]["created_at"]) == str(lot["created_at"])]
            later = [i for i in same if str(entries[i][1]["created_at"]) > str(lot["created_at"])]
            anchor = tied[-1] if tied else (later[0] if later else len(entries))
            entries.insert(anchor, (0, lot))
    seq = 0
    for is_trade, row in entries:
        seq += 1
        created_at = str(row["created_at"])
        if is_trade:
            connection.execute("UPDATE transactions SET seq = ? WHERE id = ?", (seq, row["id"]))
        else:
            connection.execute(
                """
                INSERT INTO ledger_events (
                    portfolio_id, kind, occurred_on, ticker, quantity, price, note, seq, created_at
                ) VALUES (?, 'ADJUSTMENT', ?, ?, ?, ?, 'Position edited by hand', ?, ?)
                """,
                (
                    row["portfolio_id"],
                    str(row["acquired"])[:10],
                    str(row["ticker"]).upper(),
                    float(row["quantity_original"]),
                    float(row["cost_per_unit"]),
                    seq,
                    created_at,
                ),
            )
    _set_meta(connection, "ledger_seq", str(seq))

    # The currency of each trade, from its position or the snapshot of it.
    for row in connection.execute(
        "SELECT id, portfolio_id, ticker, holding_snapshot FROM transactions WHERE currency IS NULL"
    ).fetchall():
        holding = _holding_row(connection, int(row["portfolio_id"]), str(row["ticker"]))
        currency = str(holding["currency"]) if holding is not None else None
        if currency is None and row["holding_snapshot"]:
            try:
                currency = json.loads(row["holding_snapshot"]).get("currency")
            except (TypeError, ValueError):
                currency = None
        if currency:
            connection.execute(
                "UPDATE transactions SET currency = ? WHERE id = ?", (currency, row["id"])
            )

    for portfolio in connection.execute("SELECT id FROM portfolios").fetchall():
        portfolio_id = int(portfolio["id"])
        _record_hand_edits(connection, portfolio_id)
        try:
            _rebuild(connection, portfolio_id)
        except ledger.LedgerError as exc:
            logger.warning("Portfolio %d: ledger could not be rebuilt: %s", portfolio_id, exc)


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


def _transaction_row_to_dict(row: sqlite3.Row, superseded: set[str] | None = None) -> dict[str, Any]:
    """Map a transaction row. ``superseded`` names orders a hand edit replaced."""
    return {
        "id": int(row["id"]),
        "portfolio_id": int(row["portfolio_id"]),
        "ticker": str(row["ticker"]),
        "order_type": str(row["order_type"]),
        "quantity": float(row["quantity"]),
        "price": float(row["price"]),
        "fee": float(row["fee"] or 0.0),
        "tax": float(row["tax"] or 0.0),
        "currency": row["currency"],
        "realized_pnl": float(row["realized_pnl"]),
        "executed_at": str(row["executed_at"]),
        "notes": str(row["notes"]),
        "superseded": f"tx:{row['id']}" in (superseded or set()),
        "created_at": str(row["created_at"]),
    }


def delete_portfolio(portfolio_id: int, settings: Settings = SETTINGS) -> None:
    """Delete a portfolio and everything in it."""
    with connect(settings) as connection:
        cursor = connection.execute("DELETE FROM portfolios WHERE id = ?", (portfolio_id,))
        if cursor.rowcount == 0:
            raise StoreError(f"no portfolio with id {portfolio_id}")
        for table in (
            "holdings",
            "cash_flows",
            "transactions",
            "ledger_events",
            "lots",
            "sleeves",
            "compliance_rules",
            "report_schedules",
        ):
            connection.execute(f"DELETE FROM {table} WHERE portfolio_id = ?", (portfolio_id,))
        audit.record(connection, portfolio_id, "portfolio.delete", "portfolio", portfolio_id)
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
        _record_hand_edits(connection, portfolio_id)
        audit.record(connection, portfolio_id, "position.create", "holding", cursor.lastrowid, {"after": values})
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
            "SELECT * FROM holdings WHERE id = ? AND portfolio_id = ?",
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
        _record_hand_edits(connection, portfolio_id)
        audit.record(
            connection,
            portfolio_id,
            "position.update",
            "holding",
            holding_id,
            {"before": _row_to_dict(existing), "after": values},
        )
        _bump_revision(connection)
        row = connection.execute("SELECT * FROM holdings WHERE id = ?", (holding_id,)).fetchone()
    return _row_to_dict(row)


def delete_holding(
    holding_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    with connect(settings) as connection:
        existing = connection.execute(
            "SELECT * FROM holdings WHERE id = ? AND portfolio_id = ?", (holding_id, portfolio_id)
        ).fetchone()
        if existing is None:
            raise HoldingNotFound(f"holding {holding_id} does not exist")
        connection.execute("DELETE FROM holdings WHERE id = ?", (holding_id,))
        _record_hand_edits(connection, portfolio_id)
        audit.record(connection, portfolio_id, "position.delete", "holding", holding_id, {"before": _row_to_dict(existing)})
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
        audit.record(connection, portfolio_id, "settings.base_currency", "portfolio", portfolio_id, {"after": code})
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
        audit.record(
            connection,
            cursor.lastrowid,
            "portfolio.create",
            "portfolio",
            cursor.lastrowid,
            {"name": label, "base_currency": code},
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


def build_portfolio(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> Portfolio:
    """Materialise the stored rows into the domain object analytics consume.

    The positions held now carry their open lots; the ledger carries every
    event, so the analytics can also rebuild what was held in the past.
    """
    rows = list_holdings(settings, portfolio_id)
    if not rows:
        raise EmptyPortfolio("the portfolio has no positions")
    lots = position_lots(settings, portfolio_id)
    from .governance import mandate_for

    with connect(settings) as connection:
        if _has_table(connection, "sleeves"):
            policy, model_name, model_weights, sleeves, membership = mandate_for(connection, portfolio_id)
        else:
            policy, model_name, model_weights, sleeves, membership = None, None, None, (), {}
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
            sleeve=membership.get(int(row["id"])),
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
    events, currencies = portfolio_ledger(settings, portfolio_id)
    return Portfolio(
        base_currency=get_base_currency(settings, portfolio_id),
        holdings=holdings,
        cash_flows=cash_flows,
        ledger=events,
        currencies=currencies,
        benchmark_policy=policy,
        model_name=model_name,
        model_weights=model_weights,
        sleeves=sleeves,
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
        audit.record(
            connection,
            portfolio_id,
            "cash_flow.create",
            "cash_flow",
            cursor.lastrowid,
            {"occurred_on": occurred_on, "amount": amount, "note": note},
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
        audit.record(connection, portfolio_id, "cash_flow.delete", "cash_flow", cash_flow_id)
        _bump_revision(connection)


# ---------------------------------------------------------------------------
# The book of record: trades, ledger events and their replay
# ---------------------------------------------------------------------------
#
# Positions are derived, never edited incrementally. Every change - an order,
# a dividend, a split, a hand edit of a position - is stored as an event, and
# the lots, the realised result of each sale and the positions themselves are
# rebuilt by replaying every event of the portfolio (see ledger.py). A change
# that would leave the events impossible (a sale of units no longer there) is
# refused and rolled back.

# Quantities below this are treated as zero, so floating-point residue from a
# sale never leaves a dust position behind.
_QTY_EPS = ledger.QTY_EPS

# Events the owner can record directly. Trades go through ``place_order`` and
# hand edits of a position are recorded as ``ADJUSTMENT`` automatically.
RECORDABLE_KINDS = (
    "DIVIDEND",
    "FEE",
    "TAX",
    "SPLIT",
    "SYMBOL_CHANGE",
    "SPINOFF",
    "RETURN_OF_CAPITAL",
    "FX",
)

_EVENT_COLUMNS = (
    "id, portfolio_id, kind, occurred_on, ticker, quantity, price, amount, currency, "
    "fee, tax, ratio, new_ticker, cost_fraction, to_currency, to_amount, note, seq, created_at"
)


class LedgerValidationError(StoreError):
    """A ledger event cannot apply (e.g. a split of a position not held)."""


def _next_seq(connection: sqlite3.Connection) -> int:
    """The next number in the portfolio-wide recording order."""
    current = int(_get_meta(connection, "ledger_seq") or 0)
    _set_meta(connection, "ledger_seq", str(current + 1))
    return current + 1


def _portfolio_currency(connection: sqlite3.Connection, portfolio_id: int) -> str:
    row = connection.execute(
        "SELECT base_currency FROM portfolios WHERE id = ?", (portfolio_id,)
    ).fetchone()
    return str(row["base_currency"]).upper() if row is not None else SETTINGS.base_currency


def _events(connection: sqlite3.Connection, portfolio_id: int) -> list[ledger.LedgerEvent]:
    """Every trade, recorded event and cash flow of a portfolio, as ledger events."""
    base = _portfolio_currency(connection, portfolio_id)
    events: list[ledger.LedgerEvent] = []
    for row in connection.execute(
        "SELECT * FROM transactions WHERE portfolio_id = ?", (portfolio_id,)
    ).fetchall():
        events.append(
            ledger.LedgerEvent(
                key=f"tx:{row['id']}",
                kind=str(row["order_type"]),
                on=str(row["executed_at"])[:10],
                seq=int(row["seq"] or 0),
                ticker=str(row["ticker"]).upper(),
                quantity=float(row["quantity"]),
                price=float(row["price"]),
                currency=row["currency"],
                fee=float(row["fee"] or 0.0),
                tax=float(row["tax"] or 0.0),
            )
        )
    for row in connection.execute(
        f"SELECT {_EVENT_COLUMNS} FROM ledger_events WHERE portfolio_id = ?", (portfolio_id,)
    ).fetchall():
        events.append(_event_from_row(row))
    for row in connection.execute(
        "SELECT id, occurred_on, amount, note FROM cash_flows WHERE portfolio_id = ?",
        (portfolio_id,),
    ).fetchall():
        amount = float(row["amount"])
        if amount == 0:
            continue
        events.append(
            ledger.LedgerEvent(
                key=f"cf:{row['id']}",
                kind="DEPOSIT" if amount > 0 else "WITHDRAWAL",
                on=str(row["occurred_on"])[:10],
                amount=abs(amount),
                currency=base,
                note=str(row["note"]),
            )
        )
    return events


def _event_from_row(row: sqlite3.Row) -> ledger.LedgerEvent:
    return ledger.LedgerEvent(
        key=f"ev:{row['id']}",
        kind=str(row["kind"]),
        on=str(row["occurred_on"])[:10],
        seq=int(row["seq"] or 0),
        ticker=(str(row["ticker"]).upper() if row["ticker"] else None),
        quantity=float(row["quantity"] or 0.0),
        price=float(row["price"] or 0.0),
        amount=float(row["amount"] or 0.0),
        currency=row["currency"],
        fee=float(row["fee"] or 0.0),
        tax=float(row["tax"] or 0.0),
        ratio=float(row["ratio"] if row["ratio"] is not None else 1.0),
        new_ticker=(str(row["new_ticker"]).upper() if row["new_ticker"] else None),
        cost_fraction=float(row["cost_fraction"] or 0.0),
        to_currency=row["to_currency"],
        to_amount=float(row["to_amount"] or 0.0),
        note=str(row["note"] or ""),
    )


def _holding_row(
    connection: sqlite3.Connection, portfolio_id: int, ticker: str
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM holdings WHERE portfolio_id = ? AND ticker = ? COLLATE NOCASE",
        (portfolio_id, ticker),
    ).fetchone()


def _matches(position: tuple[float, float, str | None], holding: sqlite3.Row) -> bool:
    """Whether a replayed position is exactly the stored one."""
    quantity, cost, earliest = position
    held = float(holding["quantity"])
    basis = float(holding["cost_basis_per_unit"])
    return (
        abs(quantity - held) <= _QTY_EPS * max(1.0, held)
        and abs(cost - basis) <= 1e-9 * max(1.0, abs(basis))
        and earliest == str(holding["acquired"])[:10]
    )


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
    """Describe a ticker held for the first time, from the instrument lookup."""
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


def _remembered_metadata(
    connection: sqlite3.Connection, portfolio_id: int, ticker: str
) -> dict[str, Any] | None:
    """How a position that is not held now was described when it last was."""
    row = connection.execute(
        """
        SELECT holding_snapshot FROM transactions
        WHERE portfolio_id = ? AND ticker = ? COLLATE NOCASE AND holding_snapshot IS NOT NULL
        ORDER BY seq DESC, id DESC LIMIT 1
        """,
        (portfolio_id, ticker),
    ).fetchone()
    if row is None:
        return None
    try:
        return dict(json.loads(row["holding_snapshot"]))
    except (TypeError, ValueError):
        return None


def _record_hand_edits(connection: sqlite3.Connection, portfolio_id: int) -> None:
    """Record every position that differs from its events as an adjustment.

    A position typed in, edited or deleted by hand is the truth from then on.
    Recording that as an ``ADJUSTMENT`` keeps the ledger the one source the
    positions are rebuilt from; the unit events of that ticker recorded before
    it stop applying.
    """
    events = _events(connection, portfolio_id)
    try:
        replayed = ledger.replay(events, _portfolio_currency(connection, portfolio_id))
    except ledger.LedgerError:
        # The stored events no longer add up (a database from an older
        # version). Every position starts again from what is held now.
        replayed = None
    holdings = {
        str(row["ticker"]).upper(): row
        for row in connection.execute(
            "SELECT * FROM holdings WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchall()
    }
    tickers = set(holdings)
    if replayed is not None:
        tickers |= set(replayed.lots)
    else:
        tickers |= {e.ticker for e in events if e.ticker and e.kind in ledger.UNIT_KINDS}
    for ticker in sorted(tickers):
        holding = holdings.get(ticker)
        if replayed is not None:
            position = replayed.position(ticker)
            if holding is None and position[0] <= _QTY_EPS:
                continue
            if holding is not None and _matches(position, holding):
                continue
        connection.execute(
            """
            INSERT INTO ledger_events (
                portfolio_id, kind, occurred_on, ticker, quantity, price, currency,
                note, seq, created_at
            ) VALUES (?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                portfolio_id,
                str(holding["acquired"])[:10] if holding is not None else date.today().isoformat(),
                ticker,
                float(holding["quantity"]) if holding is not None else 0.0,
                float(holding["cost_basis_per_unit"]) if holding is not None else 0.0,
                str(holding["currency"]) if holding is not None else None,
                "Position edited by hand" if holding is not None else "Position removed by hand",
                _next_seq(connection),
                _now(),
            ),
        )


def _rebuild(
    connection: sqlite3.Connection,
    portfolio_id: int,
    hints: dict[str, dict[str, Any]] | None = None,
) -> ledger.Replay:
    """Replay the portfolio and write back what it adds up to.

    Lots, the FIFO allocation and realised result of every sale, and the
    positions themselves are all rewritten from the replay. ``hints`` gives
    the description of a position that is about to be (re)opened.

    Raises:
        ledger.LedgerError: the events do not add up; nothing is written.
    """
    base = _portfolio_currency(connection, portfolio_id)
    replayed = ledger.replay(_events(connection, portfolio_id), base)
    now = _now()

    connection.execute("DELETE FROM lots WHERE portfolio_id = ?", (portfolio_id,))
    for ticker, open_lots in replayed.lots.items():
        for lot in open_lots:
            connection.execute(
                """
                INSERT INTO lots (
                    portfolio_id, ticker, acquired, quantity_original, quantity_remaining,
                    cost_per_unit, transaction_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    portfolio_id,
                    ticker,
                    lot.acquired,
                    lot.quantity,
                    lot.quantity,
                    lot.cost_per_unit,
                    lot.transaction_id,
                    now,
                ),
            )

    connection.execute(
        "DELETE FROM sell_allocations WHERE transaction_id IN "
        "(SELECT id FROM transactions WHERE portfolio_id = ?)",
        (portfolio_id,),
    )
    for key, sale in replayed.sales.items():
        if not key.startswith("tx:"):
            continue
        transaction_id = int(key[3:])
        connection.execute(
            "UPDATE transactions SET realized_pnl = ? WHERE id = ?",
            (sale.realized, transaction_id),
        )
        for allocation in sale.allocations:
            lot_ref = int(allocation.origin[3:]) if allocation.origin.startswith("tx:") else 0
            connection.execute(
                "INSERT INTO sell_allocations (transaction_id, lot_id, quantity) VALUES (?, ?, ?)",
                (transaction_id, lot_ref, allocation.quantity),
            )

    holdings = {
        str(row["ticker"]).upper(): row
        for row in connection.execute(
            "SELECT * FROM holdings WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchall()
    }
    for ticker in sorted(set(holdings) | set(replayed.lots)):
        quantity, cost, earliest = replayed.position(ticker)
        holding = holdings.get(ticker)
        if quantity <= _QTY_EPS:
            if holding is not None:
                connection.execute("DELETE FROM holdings WHERE id = ?", (holding["id"],))
            continue
        if holding is not None:
            if not _matches((quantity, cost, earliest), holding):
                connection.execute(
                    """
                    UPDATE holdings
                    SET quantity = ?, cost_basis_per_unit = ?, acquired = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (quantity, cost, earliest, now, holding["id"]),
                )
            continue
        meta = (
            (hints or {}).get(ticker)
            or _remembered_metadata(connection, portfolio_id, ticker)
            or _instrument_metadata(ticker)
        )
        currency = replayed.currencies.get(ticker) or meta.get("currency") or "USD"
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
                meta.get("name") or ticker,
                meta.get("asset_class") or "Stock",
                meta.get("region"),
                currency,
                quantity,
                cost,
                earliest,
                meta.get("target_weight"),
                now,
                now,
            ),
        )
    return replayed


def portfolio_ledger(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> tuple[tuple[ledger.LedgerEvent, ...], dict[str, str]]:
    """Every event of the portfolio, and the currency of each position in it.

    The currencies cover positions no longer held, whose history the
    analytics still need to price.
    """
    with connect(settings) as connection:
        if not _has_table(connection, "ledger_events"):
            return (), {}
        events = _events(connection, portfolio_id)
        currencies: dict[str, str] = {}
        for row in connection.execute(
            "SELECT ticker, currency FROM holdings WHERE portfolio_id = ?", (portfolio_id,)
        ).fetchall():
            currencies[str(row["ticker"]).upper()] = str(row["currency"])
        for event in events:
            if event.ticker and event.currency:
                currencies.setdefault(event.ticker, str(event.currency))
    return tuple(events), currencies


def _has_table(connection: sqlite3.Connection, name: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone()
        is not None
    )


def position_lots(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, tuple[Lot, ...]]:
    """Open lots per ticker, as the ledger replays them."""
    events, _ = portfolio_ledger(settings, portfolio_id)
    if not events:
        return {}
    with connect(settings) as connection:
        base = _portfolio_currency(connection, portfolio_id)
    try:
        replayed = ledger.replay(events, base)
    except ledger.LedgerError:
        return {}
    return {
        ticker: tuple(Lot(acquired=lot.acquired, quantity=lot.quantity) for lot in open_lots)
        for ticker, open_lots in replayed.lots.items()
    }


def list_transactions(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    """Every executed Buy/Sell order for this portfolio, newest first."""
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT * FROM transactions
            WHERE portfolio_id = ?
            ORDER BY executed_at DESC, id DESC
            """,
            (portfolio_id,),
        ).fetchall()
        superseded = _superseded_keys(connection, portfolio_id)
    return [_transaction_row_to_dict(row, superseded) for row in rows]


def _superseded_keys(connection: sqlite3.Connection, portfolio_id: int) -> set[str]:
    try:
        return ledger.replay(
            _events(connection, portfolio_id), _portfolio_currency(connection, portfolio_id)
        ).superseded
    except ledger.LedgerError:
        return set()


def place_order(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    """Record a Buy or Sell order and rebuild the positions from the ledger.

    A buy opens a new lot dated on its execution day; its fee is part of what
    the units cost. A sell consumes the oldest lots already held on its
    execution day; its realised result is the proceeds after its fee, less
    the cost of exactly those lots. A tax on the order is reported on its own.
    """
    ticker_clean = str(data["ticker"]).strip().upper()
    order_type_clean = str(data["order_type"]).strip().upper()
    quantity = float(data["quantity"])
    price = float(data["price"])
    fee = float(data.get("fee") or 0.0)
    tax = float(data.get("tax") or 0.0)
    executed_at = str(data["executed_at"])
    notes = str(data.get("notes", "")).strip()

    if quantity <= 0:
        raise OrderValidationError("Order quantity must be positive")
    if price < 0:
        raise OrderValidationError("Order price must be non-negative")
    if fee < 0 or tax < 0:
        raise OrderValidationError("Fees and taxes must be non-negative")
    if order_type_clean not in ("BUY", "SELL"):
        raise OrderValidationError(f"Invalid order type: {order_type_clean}")

    with connect(settings) as connection:
        _record_hand_edits(connection, portfolio_id)
        holding = _holding_row(connection, portfolio_id, ticker_clean)
        if order_type_clean == "SELL" and holding is None:
            raise OrderValidationError(f"Cannot sell {ticker_clean}: no position in portfolio")

        metadata = _holding_metadata(holding) if holding is not None else None
        if metadata is None:
            metadata = _remembered_metadata(connection, portfolio_id, ticker_clean) or (
                _instrument_metadata(ticker_clean)
            )
        snapshot = json.dumps(metadata) if order_type_clean == "SELL" else None

        cursor = connection.execute(
            """
            INSERT INTO transactions (
                portfolio_id, ticker, order_type, quantity, price, fee, tax, currency,
                realized_pnl, executed_at, notes, created_at, holding_snapshot, seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?, ?)
            """,
            (
                portfolio_id,
                ticker_clean,
                order_type_clean,
                quantity,
                price,
                fee,
                tax,
                metadata.get("currency"),
                executed_at,
                notes,
                _now(),
                snapshot,
                _next_seq(connection),
            ),
        )
        tx_id = cursor.lastrowid
        try:
            _rebuild(connection, portfolio_id, {ticker_clean: metadata})
        except ledger.LedgerError as exc:
            raise OrderValidationError(str(exc)) from exc
        audit.record(
            connection,
            portfolio_id,
            "order.place",
            "transaction",
            tx_id,
            {
                "ticker": ticker_clean,
                "order_type": order_type_clean,
                "quantity": quantity,
                "price": price,
                "fee": fee,
                "tax": tax,
                "executed_at": executed_at,
            },
        )
        _bump_revision(connection)
        tx_row = connection.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone()

    return _transaction_row_to_dict(tx_row)


def delete_transaction(
    transaction_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Delete a recorded transaction and rebuild the positions without it.

    Deleting a sale returns its units, reopening the position if the sale had
    closed it. Deleting a purchase whose units a later sale needed is
    refused. An order from before a hand edit of its position no longer
    applies, so deleting it only removes the record.
    """
    with connect(settings) as connection:
        tx = connection.execute(
            "SELECT * FROM transactions WHERE id = ? AND portfolio_id = ?",
            (transaction_id, portfolio_id),
        ).fetchone()
        if tx is None:
            raise TransactionNotFound(f"no transaction with id {transaction_id}")
        _record_hand_edits(connection, portfolio_id)

        ticker = str(tx["ticker"]).upper()
        hints: dict[str, dict[str, Any]] = {}
        if tx["holding_snapshot"]:
            try:
                hints[ticker] = dict(json.loads(tx["holding_snapshot"]))
            except (TypeError, ValueError):
                pass

        connection.execute(
            "DELETE FROM sell_allocations WHERE transaction_id = ?", (transaction_id,)
        )
        connection.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
        try:
            _rebuild(connection, portfolio_id, hints)
        except ledger.LedgerError as exc:
            if tx["order_type"] == "BUY":
                raise TransactionConflict(
                    f"units from this purchase of {ticker} were sold by a later order; "
                    "delete that sale first"
                ) from exc
            raise TransactionConflict(
                f"deleting this order would leave a later entry impossible: {exc}"
            ) from exc
        audit.record(
            connection,
            portfolio_id,
            "order.delete",
            "transaction",
            transaction_id,
            {"before": _transaction_row_to_dict(tx)},
        )
        _bump_revision(connection)


def list_ledger_events(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    """Every recorded event other than trades and cash flows, newest first."""
    with connect(settings) as connection:
        rows = connection.execute(
            f"""
            SELECT {_EVENT_COLUMNS} FROM ledger_events
            WHERE portfolio_id = ?
            ORDER BY occurred_on DESC, seq DESC
            """,
            (portfolio_id,),
        ).fetchall()
        superseded = _superseded_keys(connection, portfolio_id)
    return [_event_row_to_dict(row, superseded) for row in rows]


def _event_row_to_dict(row: sqlite3.Row, superseded: set[str]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": str(row["kind"]),
        "occurred_on": str(row["occurred_on"]),
        "ticker": row["ticker"],
        "quantity": float(row["quantity"] or 0.0),
        "price": float(row["price"] or 0.0),
        "amount": float(row["amount"] or 0.0),
        "currency": row["currency"],
        "fee": float(row["fee"] or 0.0),
        "tax": float(row["tax"] or 0.0),
        "ratio": float(row["ratio"] if row["ratio"] is not None else 1.0),
        "new_ticker": row["new_ticker"],
        "cost_fraction": float(row["cost_fraction"] or 0.0),
        "to_currency": row["to_currency"],
        "to_amount": float(row["to_amount"] or 0.0),
        "note": str(row["note"] or ""),
        "superseded": f"ev:{row['id']}" in superseded,
        "created_at": str(row["created_at"]),
    }


def create_ledger_event(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    """Record a dividend, fee, tax, corporate action or currency conversion.

    Raises:
        LedgerValidationError: the event cannot apply to the portfolio.
    """
    kind = str(data["kind"]).strip().upper()
    if kind not in RECORDABLE_KINDS:
        raise LedgerValidationError(f"unknown event kind {kind!r}")
    ticker = (str(data.get("ticker") or "").strip().upper()) or None
    new_ticker = (str(data.get("new_ticker") or "").strip().upper()) or None
    currency = (str(data.get("currency") or "").strip().upper()) or None
    to_currency = (str(data.get("to_currency") or "").strip().upper()) or None

    with connect(settings) as connection:
        _record_hand_edits(connection, portfolio_id)
        holding = _holding_row(connection, portfolio_id, ticker) if ticker else None
        if kind in ("DIVIDEND", "SPLIT", "SYMBOL_CHANGE", "SPINOFF", "RETURN_OF_CAPITAL") and not ticker:
            raise LedgerValidationError(f"a {kind.lower().replace('_', ' ')} needs a ticker")
        if currency is None:
            if holding is not None:
                currency = normalise_currency(str(holding["currency"]))[0]
            elif kind not in ("SPLIT", "SYMBOL_CHANGE", "SPINOFF"):
                currency = _portfolio_currency(connection, portfolio_id)

        cursor = connection.execute(
            """
            INSERT INTO ledger_events (
                portfolio_id, kind, occurred_on, ticker, quantity, price, amount, currency,
                fee, tax, ratio, new_ticker, cost_fraction, to_currency, to_amount,
                note, seq, created_at
            ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                portfolio_id,
                kind,
                str(data["occurred_on"])[:10],
                ticker,
                float(data.get("amount") or 0.0),
                currency,
                float(data.get("fee") or 0.0),
                float(data.get("tax") or 0.0),
                float(data["ratio"]) if data.get("ratio") is not None else 1.0,
                new_ticker,
                float(data.get("cost_fraction") or 0.0),
                to_currency,
                float(data.get("to_amount") or 0.0),
                str(data.get("note") or "").strip(),
                _next_seq(connection),
                _now(),
            ),
        )
        event_id = cursor.lastrowid

        hints: dict[str, dict[str, Any]] = {}
        if new_ticker and holding is not None:
            parent = _holding_metadata(holding)
            looked_up = _instrument_metadata(new_ticker)
            hints[new_ticker] = {
                **parent,
                "name": looked_up["name"] if looked_up["name"] != new_ticker else new_ticker,
                "target_weight": parent["target_weight"] if kind == "SYMBOL_CHANGE" else None,
            }
        try:
            _rebuild(connection, portfolio_id, hints)
        except ledger.LedgerError as exc:
            raise LedgerValidationError(str(exc)) from exc
        audit.record(
            connection,
            portfolio_id,
            "ledger.create",
            "ledger_event",
            event_id,
            {"kind": kind, "ticker": ticker, "occurred_on": str(data["occurred_on"])[:10]},
        )
        _bump_revision(connection)
        row = connection.execute(
            f"SELECT {_EVENT_COLUMNS} FROM ledger_events WHERE id = ?", (event_id,)
        ).fetchone()
        superseded = _superseded_keys(connection, portfolio_id)
    return _event_row_to_dict(row, superseded)


def delete_ledger_event(
    event_id: int,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Delete a recorded event and rebuild the positions without it.

    Raises:
        TransactionNotFound: no such event.
        TransactionConflict: a later entry depends on it (e.g. a sale of the
            units a split created).
    """
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT kind FROM ledger_events WHERE id = ? AND portfolio_id = ?",
            (event_id, portfolio_id),
        ).fetchone()
        if row is None:
            raise TransactionNotFound(f"no ledger event with id {event_id}")
        if str(row["kind"]) == "ADJUSTMENT":
            raise TransactionConflict(
                "a hand edit of a position is undone by editing the position again"
            )
        _record_hand_edits(connection, portfolio_id)
        connection.execute("DELETE FROM ledger_events WHERE id = ?", (event_id,))
        try:
            _rebuild(connection, portfolio_id)
        except ledger.LedgerError as exc:
            raise TransactionConflict(
                f"deleting this entry would leave a later one impossible: {exc}"
            ) from exc
        audit.record(connection, portfolio_id, "ledger.delete", "ledger_event", event_id, {"kind": str(row["kind"])})
        _bump_revision(connection)


def get_realized_pnl_summary(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, Any]:
    """Realised result, win/loss counts and trade volume of the orders that apply."""
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT id, order_type, quantity, price, fee, realized_pnl FROM transactions "
            "WHERE portfolio_id = ?",
            (portfolio_id,),
        ).fetchall()
        superseded = _superseded_keys(connection, portfolio_id)
    rows = [r for r in rows if f"tx:{r['id']}" not in superseded]

    sells = [r for r in rows if r["order_type"] == "SELL"]
    buys = [r for r in rows if r["order_type"] == "BUY"]
    total_realized_pnl = sum(float(r["realized_pnl"]) for r in sells)
    winning_trades = sum(1 for r in sells if float(r["realized_pnl"]) > 0)
    losing_trades = sum(1 for r in sells if float(r["realized_pnl"]) < 0)

    return {
        "total_realized_pnl": round(total_realized_pnl, 2),
        "total_trades": len(rows),
        "total_buys": len(buys),
        "total_sells": len(sells),
        "winning_trades": winning_trades,
        "losing_trades": losing_trades,
        "win_rate_pct": (winning_trades / len(sells)) if sells else None,
        "total_buy_volume": round(sum(float(r["quantity"]) * float(r["price"]) for r in buys), 2),
        "total_sell_volume": round(sum(float(r["quantity"]) * float(r["price"]) for r in sells), 2),
        "total_fees": round(sum(float(r["fee"] or 0.0) for r in rows), 2),
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
        _record_hand_edits(connection, DEFAULT_PORTFOLIO_ID)
        _set_meta(connection, "seeded", "1")
        audit.record(connection, DEFAULT_PORTFOLIO_ID, "portfolio.seed", "portfolio", DEFAULT_PORTFOLIO_ID, {"positions": imported})
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
        _record_hand_edits(connection, portfolio_id)
        _set_meta(connection, "seeded", "1")
        audit.record(
            connection,
            portfolio_id,
            "positions.replace",
            "portfolio",
            portfolio_id,
            {"positions": len(normalised), "base_currency": base_currency.strip().upper()},
        )
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
