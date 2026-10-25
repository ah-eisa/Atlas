"""The audit trail: who changed what, when, in an order that cannot be rewritten.

Every change to a portfolio - a position, an order, a ledger entry, the
mandate, a rule, a schedule, a setting - writes one entry in the same
transaction as the change itself, so the change and its record succeed or
fail together.

The log is append-only twice over. Triggers refuse any UPDATE or DELETE on
the table, and each entry stores a SHA-256 hash of its own content together
with the previous entry's hash. Editing an entry with the triggers removed,
deleting one, or inserting one out of order breaks the chain from that point
on, and :func:`verify` says where.

Who made a change is the ``actor`` of the request: the API sets it per
request (``api`` with no key configured, ``key:<fingerprint>`` with one);
scripts and the scheduler leave the default or set their own.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

GENESIS = "0" * 64

# The actor of the change in progress; set by the API middleware per request.
ACTOR: ContextVar[str] = ContextVar("audit_actor", default="local")


def _digest(prev_hash: str, entry: dict[str, Any]) -> str:
    payload = json.dumps(entry, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{prev_hash}|{payload}".encode("utf-8")).hexdigest()


def _content(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "portfolio_id": row["portfolio_id"],
        "at": row["at"],
        "actor": row["actor"],
        "action": row["action"],
        "entity": row["entity"],
        "entity_id": row["entity_id"],
        "detail": row["detail"],
    }


def _has_log(connection: sqlite3.Connection) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'"
        ).fetchone()
        is not None
    )


def record(
    connection: sqlite3.Connection,
    portfolio_id: int | None,
    action: str,
    entity: str,
    entity_id: Any = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append one entry. Call it inside the transaction that makes the change.

    ``action`` is a dotted verb (``order.place``, ``position.update``);
    ``detail`` holds what changed - the new values, and the old ones where a
    value was replaced.
    """
    if not _has_log(connection):
        # A database read before its migration has run (a script) has no log.
        return
    last = connection.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
    prev_hash = str(last["hash"]) if last is not None else GENESIS
    entry = {
        "portfolio_id": portfolio_id,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "actor": ACTOR.get(),
        "action": action,
        "entity": entity,
        "entity_id": None if entity_id is None else str(entity_id),
        "detail": json.dumps(detail or {}, sort_keys=True, default=str),
    }
    connection.execute(
        """
        INSERT INTO audit_log (portfolio_id, at, actor, action, entity, entity_id, detail, prev_hash, hash)
        VALUES (:portfolio_id, :at, :actor, :action, :entity, :entity_id, :detail, :prev_hash, :hash)
        """,
        {**entry, "prev_hash": prev_hash, "hash": _digest(prev_hash, entry)},
    )


def entries(
    connection: sqlite3.Connection,
    portfolio_id: int | None = None,
    *,
    limit: int = 200,
    before_id: int | None = None,
    action: str | None = None,
) -> list[dict[str, Any]]:
    """Entries newest first, for one portfolio (with the global ones) or all."""
    clauses: list[str] = []
    params: list[Any] = []
    if portfolio_id is not None:
        clauses.append("(portfolio_id = ? OR portfolio_id IS NULL)")
        params.append(portfolio_id)
    if before_id is not None:
        clauses.append("id < ?")
        params.append(before_id)
    if action:
        clauses.append("action LIKE ?")
        params.append(f"{action}%")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = connection.execute(
        f"SELECT * FROM audit_log {where} ORDER BY id DESC LIMIT ?", (*params, limit)
    ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "portfolio_id": row["portfolio_id"],
            "at": str(row["at"]),
            "actor": str(row["actor"]),
            "action": str(row["action"]),
            "entity": str(row["entity"]),
            "entity_id": row["entity_id"],
            "detail": json.loads(row["detail"] or "{}"),
            "hash": str(row["hash"]),
        }
        for row in rows
    ]


def verify(connection: sqlite3.Connection) -> dict[str, Any]:
    """Walk the whole chain and report the first entry that does not hold."""
    prev_hash = GENESIS
    count = 0
    for row in connection.execute("SELECT * FROM audit_log ORDER BY id").fetchall():
        count += 1
        if str(row["prev_hash"]) != prev_hash:
            return {
                "valid": False,
                "entries": count,
                "broken_at": int(row["id"]),
                "reason": "the entry before this one was changed or removed",
            }
        expected = _digest(prev_hash, _content(row))
        if str(row["hash"]) != expected:
            return {
                "valid": False,
                "entries": count,
                "broken_at": int(row["id"]),
                "reason": "this entry was changed after it was written",
            }
        prev_hash = expected
    return {"valid": True, "entries": count, "broken_at": None, "reason": None}
