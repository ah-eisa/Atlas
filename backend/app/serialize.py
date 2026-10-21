"""JSON-safety and rounding helpers.

The API contract has two rules, applied here and nowhere else:

* **Money** is rounded to 2 decimal places, **ratios and fractions** to 4.
* The payload is strictly JSON-safe: ``NaN``, ``inf`` and ``-inf`` become
  ``null`` rather than the non-standard literals Python's ``json`` module emits
  by default (which ``JSON.parse`` in a browser rejects).
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any, Mapping, Sequence

from .config import SETTINGS


def clean_float(value: Any) -> float | None:
    """Coerce to ``float``, mapping NaN/inf and unconvertible values to ``None``."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def round_money(value: Any, dp: int | None = None) -> float | None:
    """Round a monetary amount to the configured precision (2 dp)."""
    number = clean_float(value)
    return None if number is None else round(number, SETTINGS.money_dp if dp is None else dp)


def round_ratio(value: Any, dp: int | None = None) -> float | None:
    """Round a ratio or fraction to the configured precision (4 dp)."""
    number = clean_float(value)
    return None if number is None else round(number, SETTINGS.ratio_dp if dp is None else dp)


def money_series(values: Sequence[Any]) -> list[float | None]:
    """Round a sequence of monetary values."""
    return [round_money(v) for v in values]


def ratio_series(values: Sequence[Any]) -> list[float | None]:
    """Round a sequence of ratios."""
    return [round_ratio(v) for v in values]


def iso(value: date | None) -> str | None:
    """Format a date as ``YYYY-MM-DD``, passing ``None`` through."""
    return value.isoformat() if value is not None else None


def json_safe(payload: Any) -> Any:
    """Recursively replace non-finite floats with ``None``.

    A final guard applied to every response so a stray NaN from an upstream
    computation can never produce invalid JSON.
    """
    if isinstance(payload, Mapping):
        return {key: json_safe(value) for key, value in payload.items()}
    if isinstance(payload, (list, tuple)):
        return [json_safe(item) for item in payload]
    if isinstance(payload, float):
        return payload if math.isfinite(payload) else None
    return payload
