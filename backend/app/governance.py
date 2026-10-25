"""The mandate around a portfolio: what it is measured against, what it should
look like, how it is divided, and the limits it must stay within.

* A **benchmark policy** is a blended benchmark - a weighted set of indices,
  rebalanced daily or monthly - that replaces the configured benchmark for
  that portfolio in every relative figure (beta, alpha, tracking error, the
  chart).
* A **model portfolio** is a set of target weights per instrument, shared by
  every portfolio. A portfolio that follows a model is measured against its
  weights instead of the targets on its own positions.
* A **sleeve** is a named part of a portfolio (core, satellite, income) with
  its own target share; each position can belong to one.
* A **compliance rule** is a limit (see :mod:`compliance` for the kinds and
  how they are checked).

Every change here is written to the audit trail in the same transaction, and
bumps the store's revision so the analytics are rebuilt with it.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from . import audit
from .config import SETTINGS, Settings
from .data import BenchmarkComponent, BenchmarkPolicy, Sleeve
from .store import (
    DEFAULT_PORTFOLIO_ID,
    HoldingNotFound,
    StoreError,
    _bump_revision,
    _now,
    connect,
)

SYMBOL_PATTERN = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")
REBALANCE = ("daily", "monthly")
# Weights may be entered as percentages that do not quite add up after
# rounding; within this they are taken as complete and normalised.
WEIGHT_TOLERANCE = 0.005


class GovernanceError(StoreError):
    """A mandate change that is not valid (weights that do not add up...)."""


class NotFound(StoreError):
    """No such model, sleeve or rule."""


def _weights(raw: dict[str, Any], *, complete: bool) -> dict[str, float]:
    """Clean a ``{symbol: weight}`` map; ``complete`` weights must add up to one."""
    weights: dict[str, float] = {}
    for symbol, weight in raw.items():
        code = str(symbol).strip().upper()
        if not SYMBOL_PATTERN.match(code):
            raise GovernanceError(f"{symbol!r} is not a Yahoo Finance symbol")
        value = float(weight)
        if not 0.0 <= value <= 1.0:
            raise GovernanceError(f"the weight of {code} must be between 0 and 1")
        if value > 0:
            weights[code] = weights.get(code, 0.0) + value
    if not weights:
        raise GovernanceError("give at least one instrument a weight above zero")
    total = sum(weights.values())
    if complete and abs(total - 1.0) > WEIGHT_TOLERANCE:
        raise GovernanceError(f"the weights add up to {total:.1%}; they must add up to 100%")
    if total > 1.0 + WEIGHT_TOLERANCE:
        raise GovernanceError(f"the weights add up to {total:.1%}, more than 100%")
    if complete:
        weights = {code: value / total for code, value in weights.items()}
    return weights


def _portfolio_exists(connection: sqlite3.Connection, portfolio_id: int) -> None:
    if connection.execute("SELECT 1 FROM portfolios WHERE id = ?", (portfolio_id,)).fetchone() is None:
        raise NotFound(f"no portfolio with id {portfolio_id}")


# ---------------------------------------------------------------------------
# Benchmark policy
# ---------------------------------------------------------------------------


def _policy_from_json(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) and value.get("components") else None


def get_benchmark_policy(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, Any] | None:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT benchmark_policy FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
    return _policy_from_json(row["benchmark_policy"]) if row is not None else None


def set_benchmark_policy(
    data: dict[str, Any] | None,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any] | None:
    """Set the portfolio's blended benchmark, or clear it with ``None``.

    ``data`` is ``{"name", "rebalance", "components": [{"symbol", "weight"}]}``.
    """
    policy: dict[str, Any] | None = None
    if data is not None:
        components = _weights(
            {item["symbol"]: item["weight"] for item in data.get("components", [])}, complete=True
        )
        rebalance = str(data.get("rebalance") or "monthly").lower()
        if rebalance not in REBALANCE:
            raise GovernanceError("rebalance must be daily or monthly")
        name = str(data.get("name") or "").strip() or " / ".join(
            f"{weight:.0%} {symbol}" for symbol, weight in components.items()
        )
        policy = {
            "name": name[:80],
            "rebalance": rebalance,
            "components": [
                {"symbol": symbol, "weight": round(weight, 6)} for symbol, weight in components.items()
            ],
        }
    with connect(settings) as connection:
        _portfolio_exists(connection, portfolio_id)
        before = connection.execute(
            "SELECT benchmark_policy FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()["benchmark_policy"]
        connection.execute(
            "UPDATE portfolios SET benchmark_policy = ? WHERE id = ?",
            (json.dumps(policy) if policy else None, portfolio_id),
        )
        audit.record(
            connection,
            portfolio_id,
            "mandate.benchmark",
            "portfolio",
            portfolio_id,
            {"before": _policy_from_json(before), "after": policy},
        )
        _bump_revision(connection)
    return policy


# ---------------------------------------------------------------------------
# Model portfolios
# ---------------------------------------------------------------------------


def _model_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    weights = connection.execute(
        "SELECT ticker, weight FROM model_weights WHERE model_id = ? ORDER BY weight DESC, ticker",
        (row["id"],),
    ).fetchall()
    used_by = connection.execute(
        "SELECT id, name FROM portfolios WHERE model_id = ? ORDER BY id", (row["id"],)
    ).fetchall()
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "description": str(row["description"]),
        "weights": [{"ticker": str(w["ticker"]), "weight": float(w["weight"])} for w in weights],
        "total_weight": round(sum(float(w["weight"]) for w in weights), 6),
        "portfolios": [{"id": int(p["id"]), "name": str(p["name"])} for p in used_by],
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def list_models(settings: Settings = SETTINGS) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute("SELECT * FROM models ORDER BY name").fetchall()
        return [_model_dict(connection, row) for row in rows]


def _write_model_weights(
    connection: sqlite3.Connection, model_id: int, weights: dict[str, float]
) -> None:
    connection.execute("DELETE FROM model_weights WHERE model_id = ?", (model_id,))
    connection.executemany(
        "INSERT INTO model_weights (model_id, ticker, weight) VALUES (?, ?, ?)",
        [(model_id, ticker, weight) for ticker, weight in weights.items()],
    )


def save_model(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    model_id: int | None = None,
) -> dict[str, Any]:
    """Create a model portfolio, or replace one's name, description and weights.

    The weights may add up to less than 100%: the rest is cash.
    """
    name = str(data.get("name") or "").strip()
    if not name:
        raise GovernanceError("a model needs a name")
    weights = _weights({w["ticker"]: w["weight"] for w in data.get("weights", [])}, complete=False)
    description = str(data.get("description") or "").strip()[:300]
    now = _now()
    with connect(settings) as connection:
        try:
            if model_id is None:
                cursor = connection.execute(
                    "INSERT INTO models (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (name, description, now, now),
                )
                model_id = int(cursor.lastrowid)
                action = "model.create"
            else:
                cursor = connection.execute(
                    "UPDATE models SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                    (name, description, now, model_id),
                )
                if cursor.rowcount == 0:
                    raise NotFound(f"no model with id {model_id}")
                action = "model.update"
        except sqlite3.IntegrityError as exc:
            raise GovernanceError(f"a model called {name!r} already exists") from exc
        _write_model_weights(connection, model_id, weights)
        audit.record(
            connection, None, action, "model", model_id, {"name": name, "weights": weights}
        )
        _bump_revision(connection)
        row = connection.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        return _model_dict(connection, row)


def delete_model(model_id: int, settings: Settings = SETTINGS) -> None:
    """Delete a model; portfolios that followed it go back to their own targets."""
    with connect(settings) as connection:
        row = connection.execute("SELECT name FROM models WHERE id = ?", (model_id,)).fetchone()
        if row is None:
            raise NotFound(f"no model with id {model_id}")
        connection.execute("UPDATE portfolios SET model_id = NULL WHERE model_id = ?", (model_id,))
        connection.execute("DELETE FROM model_weights WHERE model_id = ?", (model_id,))
        connection.execute("DELETE FROM models WHERE id = ?", (model_id,))
        audit.record(connection, None, "model.delete", "model", model_id, {"name": str(row["name"])})
        _bump_revision(connection)


def set_portfolio_model(
    model_id: int | None,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Make the portfolio follow a model, or stop following one with ``None``."""
    with connect(settings) as connection:
        _portfolio_exists(connection, portfolio_id)
        if model_id is not None and connection.execute(
            "SELECT 1 FROM models WHERE id = ?", (model_id,)
        ).fetchone() is None:
            raise NotFound(f"no model with id {model_id}")
        before = connection.execute(
            "SELECT model_id FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()["model_id"]
        connection.execute("UPDATE portfolios SET model_id = ? WHERE id = ?", (model_id, portfolio_id))
        audit.record(
            connection,
            portfolio_id,
            "mandate.model",
            "portfolio",
            portfolio_id,
            {"before": before, "after": model_id},
        )
        _bump_revision(connection)


# ---------------------------------------------------------------------------
# Sleeves
# ---------------------------------------------------------------------------


def list_sleeves(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT s.*, (SELECT COUNT(*) FROM holdings h WHERE h.sleeve_id = s.id) AS positions
            FROM sleeves s WHERE s.portfolio_id = ? ORDER BY s.name
            """,
            (portfolio_id,),
        ).fetchall()
    return [_sleeve_dict(row) for row in rows]


def _sleeve_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "target_weight": float(row["target_weight"]) if row["target_weight"] is not None else None,
        "description": str(row["description"]),
        "positions": int(row["positions"]) if "positions" in row.keys() else 0,
        "created_at": str(row["created_at"]),
    }


def _sleeve_values(data: dict[str, Any]) -> tuple[str, float | None, str]:
    name = str(data.get("name") or "").strip()
    if not name:
        raise GovernanceError("a sleeve needs a name")
    if name.lower() in ("cash", "unassigned"):
        raise GovernanceError(f"{name!r} is reserved")
    target = data.get("target_weight")
    if target is not None:
        target = float(target)
        if not 0.0 <= target <= 1.0:
            raise GovernanceError("a sleeve's target must be between 0% and 100%")
    return name[:60], target, str(data.get("description") or "").strip()[:300]


def save_sleeve(
    data: dict[str, Any],
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
    sleeve_id: int | None = None,
) -> dict[str, Any]:
    name, target, description = _sleeve_values(data)
    with connect(settings) as connection:
        _portfolio_exists(connection, portfolio_id)
        others = connection.execute(
            "SELECT COALESCE(SUM(target_weight), 0) AS total FROM sleeves "
            "WHERE portfolio_id = ? AND id IS NOT ?",
            (portfolio_id, sleeve_id),
        ).fetchone()["total"]
        if target is not None and float(others) + target > 1.0 + WEIGHT_TOLERANCE:
            raise GovernanceError(
                f"the sleeves' targets would add up to {float(others) + target:.1%}, more than 100%"
            )
        try:
            if sleeve_id is None:
                cursor = connection.execute(
                    "INSERT INTO sleeves (portfolio_id, name, target_weight, description, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (portfolio_id, name, target, description, _now()),
                )
                sleeve_id = int(cursor.lastrowid)
                action = "sleeve.create"
            else:
                cursor = connection.execute(
                    "UPDATE sleeves SET name = ?, target_weight = ?, description = ? "
                    "WHERE id = ? AND portfolio_id = ?",
                    (name, target, description, sleeve_id, portfolio_id),
                )
                if cursor.rowcount == 0:
                    raise NotFound(f"no sleeve with id {sleeve_id}")
                action = "sleeve.update"
        except sqlite3.IntegrityError as exc:
            raise GovernanceError(f"this portfolio already has a sleeve called {name!r}") from exc
        audit.record(
            connection,
            portfolio_id,
            action,
            "sleeve",
            sleeve_id,
            {"name": name, "target_weight": target},
        )
        _bump_revision(connection)
        row = connection.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM holdings h WHERE h.sleeve_id = s.id) AS positions "
            "FROM sleeves s WHERE s.id = ?",
            (sleeve_id,),
        ).fetchone()
    return _sleeve_dict(row)


def delete_sleeve(
    sleeve_id: int, settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> None:
    """Delete a sleeve; its positions stay, outside any sleeve."""
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT name FROM sleeves WHERE id = ? AND portfolio_id = ?", (sleeve_id, portfolio_id)
        ).fetchone()
        if row is None:
            raise NotFound(f"no sleeve with id {sleeve_id}")
        connection.execute("UPDATE holdings SET sleeve_id = NULL WHERE sleeve_id = ?", (sleeve_id,))
        connection.execute("DELETE FROM sleeves WHERE id = ?", (sleeve_id,))
        audit.record(
            connection, portfolio_id, "sleeve.delete", "sleeve", sleeve_id, {"name": str(row["name"])}
        )
        _bump_revision(connection)


def assign_sleeve(
    holding_id: int,
    sleeve_id: int | None,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> None:
    """Put a position in a sleeve, or take it out of one with ``None``."""
    with connect(settings) as connection:
        holding = connection.execute(
            "SELECT ticker, sleeve_id FROM holdings WHERE id = ? AND portfolio_id = ?",
            (holding_id, portfolio_id),
        ).fetchone()
        if holding is None:
            raise HoldingNotFound(f"holding {holding_id} does not exist")
        if sleeve_id is not None and connection.execute(
            "SELECT 1 FROM sleeves WHERE id = ? AND portfolio_id = ?", (sleeve_id, portfolio_id)
        ).fetchone() is None:
            raise NotFound(f"no sleeve with id {sleeve_id} in this portfolio")
        connection.execute("UPDATE holdings SET sleeve_id = ? WHERE id = ?", (sleeve_id, holding_id))
        audit.record(
            connection,
            portfolio_id,
            "position.sleeve",
            "holding",
            holding_id,
            {"ticker": str(holding["ticker"]), "before": holding["sleeve_id"], "after": sleeve_id},
        )
        _bump_revision(connection)


# ---------------------------------------------------------------------------
# Compliance rules
# ---------------------------------------------------------------------------


def _rule_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": str(row["kind"]),
        "subject": row["subject"],
        "limit": float(row["limit_value"]) if row["limit_value"] is not None else None,
        "severity": str(row["severity"]),
        "enabled": bool(row["enabled"]),
        "note": str(row["note"]),
        "created_at": str(row["created_at"]),
    }


def list_rules(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT * FROM compliance_rules WHERE portfolio_id = ? ORDER BY id", (portfolio_id,)
        ).fetchall()
    return [_rule_dict(row) for row in rows]


def create_rule(
    data: dict[str, Any], settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, Any]:
    from .compliance import validate_rule

    kind, subject, limit = validate_rule(data)
    severity = str(data.get("severity") or "breach")
    if severity not in ("breach", "warning"):
        raise GovernanceError("severity must be breach or warning")
    with connect(settings) as connection:
        _portfolio_exists(connection, portfolio_id)
        cursor = connection.execute(
            "INSERT INTO compliance_rules (portfolio_id, kind, subject, limit_value, severity, note, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (portfolio_id, kind, subject, limit, severity, str(data.get("note") or "").strip()[:200], _now()),
        )
        audit.record(
            connection,
            portfolio_id,
            "rule.create",
            "compliance_rule",
            cursor.lastrowid,
            {"kind": kind, "subject": subject, "limit": limit, "severity": severity},
        )
        row = connection.execute(
            "SELECT * FROM compliance_rules WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return _rule_dict(row)


def set_rule_enabled(
    rule_id: int,
    enabled: bool,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    with connect(settings) as connection:
        cursor = connection.execute(
            "UPDATE compliance_rules SET enabled = ? WHERE id = ? AND portfolio_id = ?",
            (1 if enabled else 0, rule_id, portfolio_id),
        )
        if cursor.rowcount == 0:
            raise NotFound(f"no rule with id {rule_id}")
        audit.record(
            connection,
            portfolio_id,
            "rule.enable" if enabled else "rule.disable",
            "compliance_rule",
            rule_id,
        )
        row = connection.execute("SELECT * FROM compliance_rules WHERE id = ?", (rule_id,)).fetchone()
    return _rule_dict(row)


def delete_rule(
    rule_id: int, settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> None:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT * FROM compliance_rules WHERE id = ? AND portfolio_id = ?", (rule_id, portfolio_id)
        ).fetchone()
        if row is None:
            raise NotFound(f"no rule with id {rule_id}")
        connection.execute("DELETE FROM compliance_rules WHERE id = ?", (rule_id,))
        audit.record(
            connection, portfolio_id, "rule.delete", "compliance_rule", rule_id, {"before": _rule_dict(row)}
        )


# ---------------------------------------------------------------------------
# What build_portfolio reads
# ---------------------------------------------------------------------------


def mandate_for(
    connection: sqlite3.Connection, portfolio_id: int
) -> tuple[BenchmarkPolicy | None, str | None, dict[str, float] | None, tuple[Sleeve, ...], dict[int, str]]:
    """The portfolio's benchmark policy, model, sleeves, and the sleeve of each holding."""
    row = connection.execute(
        "SELECT benchmark_policy, model_id FROM portfolios WHERE id = ?", (portfolio_id,)
    ).fetchone()
    if row is None:
        return None, None, None, (), {}
    raw = _policy_from_json(row["benchmark_policy"])
    policy = (
        BenchmarkPolicy(
            name=str(raw["name"]),
            components=tuple(
                BenchmarkComponent(str(c["symbol"]), float(c["weight"])) for c in raw["components"]
            ),
            rebalance=str(raw.get("rebalance") or "monthly"),
        )
        if raw
        else None
    )
    model_name: str | None = None
    model_weights: dict[str, float] | None = None
    if row["model_id"] is not None:
        model = connection.execute(
            "SELECT name FROM models WHERE id = ?", (row["model_id"],)
        ).fetchone()
        if model is not None:
            model_name = str(model["name"])
            model_weights = {
                str(w["ticker"]).upper(): float(w["weight"])
                for w in connection.execute(
                    "SELECT ticker, weight FROM model_weights WHERE model_id = ?", (row["model_id"],)
                ).fetchall()
            }
    sleeve_rows = connection.execute(
        "SELECT id, name, target_weight FROM sleeves WHERE portfolio_id = ? ORDER BY name",
        (portfolio_id,),
    ).fetchall()
    sleeves = tuple(
        Sleeve(str(s["name"]), float(s["target_weight"]) if s["target_weight"] is not None else None)
        for s in sleeve_rows
    )
    names = {int(s["id"]): str(s["name"]) for s in sleeve_rows}
    membership = {
        int(h["id"]): names[int(h["sleeve_id"])]
        for h in connection.execute(
            "SELECT id, sleeve_id FROM holdings WHERE portfolio_id = ? AND sleeve_id IS NOT NULL",
            (portfolio_id,),
        ).fetchall()
        if int(h["sleeve_id"]) in names
    }
    return policy, model_name, model_weights, sleeves, membership
