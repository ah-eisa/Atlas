"""SQLite persistence for the user's positions.

The analytics engine is pure: it receives a :class:`~backend.app.data.Portfolio`
and market data. This module is the only place that owns mutable state. Using
SQLite (rather than editing ``holdings.json`` by hand) gives the app atomic
writes, uniqueness constraints and a revision counter the analytics cache can
observe.

The schema deliberately models *current positions*, not a trade ledger. Each row
is one lot: ticker, quantity, cost basis and acquisition date. That is exactly
what the valuation and P&L calculations need, and it avoids pretending to
support tax-lot accounting that the UI cannot yet express.
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
from .data import CashFlow, Holding, Portfolio, normalise_currency

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
]


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
                    quantity = ?, cost_basis_per_unit = ?, acquired = ?, updated_at = ?
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


def build_portfolio(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> Portfolio:
    """Materialise the stored rows into the domain object analytics consume."""
    rows = list_holdings(settings, portfolio_id)
    if not rows:
        raise EmptyPortfolio("the portfolio has no positions")
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


__all__ = [
    "DEFAULT_PORTFOLIO_ID",
    "CashFlowNotFound",
    "DuplicateTicker",
    "EmptyPortfolio",
    "HoldingNotFound",
    "StoreError",
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
