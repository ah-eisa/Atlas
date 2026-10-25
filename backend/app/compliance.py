"""Compliance: the limits a portfolio must stay within, and whether it does.

A rule is a ``kind``, sometimes a ``subject`` (the asset class, region,
currency, sleeve or instruments it is about) and a ``limit``. Weights and
risk figures are fractions (0.10 is 10%). Each rule is checked against an
:class:`Exposure` - what the portfolio holds and how risky it is - and comes
out as ``pass``, ``warning`` (within 90% of a hard limit, or past a soft one)
or ``breach``.

The same check runs before a trade: :func:`exposure_after_order` restates
the exposure as if the order had been filled at the price given, so the
trade window can say "this would breach the 10% single-position limit"
before the order is placed. The risk figures (volatility, VaR, tracking
error, drawdown) are not re-estimated for a trade; rules on them are checked
against today's figures and say so.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .store import StoreError


class RuleError(StoreError):
    """A rule that cannot be checked as written."""


# kind: (what it limits, direction, needs a subject, unit)
KINDS: dict[str, tuple[str, str, bool, str]] = {
    "max_position_weight": ("Largest single position", "max", False, "weight"),
    "max_asset_class_weight": ("Asset class", "max", True, "weight"),
    "min_asset_class_weight": ("Asset class", "min", True, "weight"),
    "max_region_weight": ("Region", "max", True, "weight"),
    "max_currency_weight": ("Exposure to a currency", "max", True, "weight"),
    "max_cash_weight": ("Cash", "max", False, "weight"),
    "min_cash_weight": ("Cash", "min", False, "weight"),
    "restricted_instruments": ("Instruments that may not be held", "none", True, "list"),
    "min_positions": ("Number of positions", "min", False, "count"),
    "max_volatility": ("Annualised volatility", "max", False, "weight"),
    "max_var_95": ("One-day 95% value at risk", "max", False, "weight"),
    "max_tracking_error": ("Tracking error", "max", False, "weight"),
    "max_drawdown": ("Drawdown from the peak", "max", False, "weight"),
    "max_sleeve_drift": ("Sleeve away from its target", "max", False, "weight"),
    "max_model_drift": ("Distance from the model", "max", False, "weight"),
}

RISK_KINDS = frozenset({"max_volatility", "max_var_95", "max_tracking_error", "max_drawdown"})

# A hard limit within this share of being reached is reported as a warning.
WARNING_BAND = 0.9


def validate_rule(data: dict[str, Any]) -> tuple[str, str | None, float | None]:
    """Check a rule as entered; return its kind, subject and limit."""
    kind = str(data.get("kind") or "").strip()
    if kind not in KINDS:
        raise RuleError(f"unknown rule kind {kind!r}")
    _, direction, needs_subject, unit = KINDS[kind]
    subject = str(data.get("subject") or "").strip() or None
    if needs_subject and subject is None:
        raise RuleError("this rule needs a subject (the class, region, currency or instruments it is about)")
    if kind == "restricted_instruments":
        assert subject is not None
        subject = ",".join(sorted({s.strip().upper() for s in subject.split(",") if s.strip()}))
        return kind, subject, None
    if kind == "max_currency_weight" and subject:
        subject = subject.upper()
    raw = data.get("limit")
    if raw is None:
        raise RuleError("this rule needs a limit")
    limit = float(raw)
    if unit == "weight" and not 0.0 <= limit <= 1.0:
        raise RuleError("a weight limit is between 0% and 100%")
    if unit == "count" and (limit < 1 or limit != int(limit)):
        raise RuleError("a count limit is a whole number of at least 1")
    return kind, subject, limit


@dataclass(frozen=True)
class Exposure:
    """What a portfolio holds and how risky it is, as the rules read it.

    Weights are shares of the whole portfolio, cash included.
    """

    total_value: float
    positions: dict[str, float]
    asset_class_of: dict[str, str]
    region_of: dict[str, str]
    currency_of: dict[str, str]
    cash: dict[str, float] = field(default_factory=dict)
    base_currency: str = "EUR"
    volatility: float | None = None
    var_95: float | None = None
    tracking_error: float | None = None
    drawdown: float | None = None
    sleeve_drift: dict[str, float] = field(default_factory=dict)
    model_drift: float | None = None

    def weight(self, value: float) -> float:
        return value / self.total_value if self.total_value > 0 else 0.0

    def grouped(self, mapping: dict[str, str]) -> dict[str, float]:
        result: dict[str, float] = {}
        for ticker, value in self.positions.items():
            key = mapping.get(ticker, "Other")
            result[key] = result.get(key, 0.0) + value
        return result

    def currency_values(self) -> dict[str, float]:
        result = self.grouped(self.currency_of)
        for currency, value in self.cash.items():
            result[currency] = result.get(currency, 0.0) + value
        return result


def exposure_from(analytics: Any) -> Exposure:
    """The exposure of a built portfolio."""
    positions = [p for p in analytics.positions if p.value_base]
    risk = analytics.risk()
    drawdown = analytics.growth_index / analytics.growth_index.cummax() - 1.0
    sleeves = analytics._sleeves_payload()
    drift = analytics._drift_payload()
    var = ((risk.get("value_at_risk") or {}).get("95") or {}).get("historical_pct")
    tracking = (risk.get("benchmark") or {}).get("tracking_error_pct")
    return Exposure(
        total_value=float(analytics.total_value),
        positions={p.ticker: float(p.value_base) for p in positions},
        asset_class_of={p.ticker: p.asset_class for p in positions},
        region_of={p.ticker: p.region for p in positions},
        currency_of={p.ticker: _major(p.currency) for p in positions},
        cash=dict(analytics.cash_values),
        base_currency=analytics.portfolio.base_currency,
        volatility=risk.get("volatility_annualized_pct"),
        var_95=var,
        tracking_error=tracking,
        drawdown=-float(drawdown.iloc[-1]) if len(drawdown) else None,
        sleeve_drift={
            row["name"]: float(row["drift"])
            for row in sleeves.get("sleeves", [])
            if row.get("drift") is not None
        },
        model_drift=float(drift["total_drift"]) if drift.get("source") == "model" else None,
    )


def _major(currency: str) -> str:
    from .data import normalise_currency

    return normalise_currency(currency)[0]


def exposure_after_order(
    exposure: Exposure,
    *,
    ticker: str,
    side: str,
    value_base: float,
    asset_class: str,
    region: str,
    currency: str,
) -> Exposure:
    """The exposure as if an order worth ``value_base`` had been filled.

    A purchase is paid from cash first; what cash cannot pay for is new
    money, which grows the portfolio. A sale's proceeds stay as cash in the
    base currency. Risk figures are carried over unchanged.
    """
    positions = dict(exposure.positions)
    cash = dict(exposure.cash)
    total = exposure.total_value
    ticker = ticker.upper()
    if side == "BUY":
        positions[ticker] = positions.get(ticker, 0.0) + value_base
        available = sum(cash.values())
        drawn = min(available, value_base)
        if available > 0:
            for key in list(cash):
                cash[key] -= drawn * cash[key] / available
        total += value_base - drawn
    else:
        held = positions.get(ticker, 0.0)
        sold = min(held, value_base)
        positions[ticker] = held - sold
        if positions[ticker] <= 0.005:
            positions.pop(ticker)
        cash[exposure.base_currency] = cash.get(exposure.base_currency, 0.0) + sold
    return replace(
        exposure,
        total_value=total,
        positions=positions,
        cash={key: value for key, value in cash.items() if abs(value) > 0.005},
        asset_class_of={**exposure.asset_class_of, ticker: exposure.asset_class_of.get(ticker, asset_class)},
        region_of={**exposure.region_of, ticker: exposure.region_of.get(ticker, region)},
        currency_of={**exposure.currency_of, ticker: exposure.currency_of.get(ticker, _major(currency))},
    )


def _status(actual: float, limit: float, direction: str, severity: str) -> str:
    if direction == "max":
        if actual > limit + 1e-9:
            return "breach" if severity == "breach" else "warning"
        if severity == "breach" and limit > 0 and actual >= WARNING_BAND * limit:
            return "warning"
        return "pass"
    if actual < limit - 1e-9:
        return "breach" if severity == "breach" else "warning"
    if severity == "breach" and actual <= limit / WARNING_BAND and limit > 0:
        return "warning"
    return "pass"


def evaluate(rule: dict[str, Any], exposure: Exposure, *, pre_trade: bool = False) -> dict[str, Any]:
    """Check one rule; returns its status, the figure, the limit and what is responsible."""
    kind = str(rule["kind"])
    label, direction, _, unit = KINDS.get(kind, (kind, "max", False, "weight"))
    subject = rule.get("subject")
    limit = rule.get("limit")
    severity = str(rule.get("severity") or "breach")
    result: dict[str, Any] = {
        "rule_id": rule.get("id"),
        "kind": kind,
        "label": label if not subject or kind == "restricted_instruments" else f"{label}: {subject}",
        "subject": subject,
        "limit": limit,
        "unit": unit,
        "severity": severity,
        "actual": None,
        "status": "pass",
        "offenders": [],
        "note": rule.get("note") or "",
    }

    def weigh(groups: dict[str, float], key: str | None) -> float:
        if key is None:
            return 0.0
        for name, value in groups.items():
            if name.lower() == key.lower():
                return exposure.weight(value)
        return 0.0

    actual: float | None
    offenders: list[str] = []
    if kind == "restricted_instruments":
        banned = {s for s in str(subject or "").split(",") if s}
        offenders = sorted(t for t in exposure.positions if t.upper() in banned)
        result.update(
            actual=float(len(offenders)),
            status=("breach" if severity == "breach" else "warning") if offenders else "pass",
            offenders=offenders,
        )
        return result
    if kind == "max_position_weight":
        weights = {t: exposure.weight(v) for t, v in exposure.positions.items()}
        actual = max(weights.values(), default=0.0)
        offenders = sorted((t for t, w in weights.items() if limit is not None and w > limit), key=lambda t: -weights[t])
    elif kind in ("max_asset_class_weight", "min_asset_class_weight"):
        actual = weigh(exposure.grouped(exposure.asset_class_of), subject)
        if subject and subject.lower() == "cash":
            actual = exposure.weight(sum(exposure.cash.values()))
    elif kind == "max_region_weight":
        actual = weigh(exposure.grouped(exposure.region_of), subject)
    elif kind == "max_currency_weight":
        actual = weigh(exposure.currency_values(), subject)
    elif kind in ("max_cash_weight", "min_cash_weight"):
        actual = exposure.weight(sum(exposure.cash.values()))
    elif kind == "min_positions":
        actual = float(len(exposure.positions))
    elif kind == "max_volatility":
        actual = exposure.volatility
    elif kind == "max_var_95":
        actual = exposure.var_95
    elif kind == "max_tracking_error":
        actual = exposure.tracking_error
    elif kind == "max_drawdown":
        actual = exposure.drawdown
    elif kind == "max_sleeve_drift":
        drifts = {name: abs(value) for name, value in exposure.sleeve_drift.items()}
        if subject:
            drifts = {name: value for name, value in drifts.items() if name.lower() == subject.lower()}
        actual = max(drifts.values(), default=None) if drifts else None
        offenders = sorted(name for name, value in drifts.items() if limit is not None and value > limit)
    elif kind == "max_model_drift":
        actual = exposure.model_drift
    else:
        actual = None

    if actual is None or limit is None:
        result.update(status="unknown", actual=actual)
        result["detail"] = "Not measurable for this portfolio yet."
        return result
    result.update(actual=actual, status=_status(float(actual), float(limit), direction, severity), offenders=offenders)
    if pre_trade and kind in RISK_KINDS:
        result["detail"] = "Checked against today's figure; a trade's effect on risk is not estimated."
    return result


def evaluate_all(
    rules: list[dict[str, Any]], exposure: Exposure, *, pre_trade: bool = False
) -> dict[str, Any]:
    """Check every enabled rule; the overall status is the worst of them."""
    results = [evaluate(rule, exposure, pre_trade=pre_trade) for rule in rules if rule.get("enabled", True)]
    order = {"breach": 3, "warning": 2, "unknown": 1, "pass": 0}
    worst = max((order[r["status"]] for r in results), default=0)
    status = next(name for name, rank in order.items() if rank == worst) if results else "pass"
    return {
        "status": status,
        "checked": len(results),
        "breaches": sum(1 for r in results if r["status"] == "breach"),
        "warnings": sum(1 for r in results if r["status"] == "warning"),
        "results": results,
    }
