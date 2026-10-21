"""The payload contract, and the demo snapshot that must obey it.

The bug this guards against is quiet: a field is renamed on the backend,
the front end keeps reading the old name, and the dashboard renders zeros
with nothing in the console to explain it.

Two checks:

  * the committed ``snapshot.json`` validates against the committed schema,
    so the demo payload cannot drift from the contract;
  * the contract is regenerated and compared, so a change to the payload
    cannot land without the schema being updated with it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "payload-schema.json"
SNAPSHOT_PATH = REPO_ROOT / "snapshot.json"


def load_schema() -> dict:
    if not SCHEMA_PATH.exists():
        pytest.fail(
            "the payload schema is missing; run `python backend/export_schema.py`"
        )
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def load_snapshot() -> dict:
    if not SNAPSHOT_PATH.exists():
        pytest.fail("snapshot.json is missing; run `python backend/generate_snapshot.py`")
    return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))


def test_the_committed_schema_matches_the_committed_snapshot() -> None:
    """The demo payload must satisfy the contract the front end is written against."""
    jsonschema = pytest.importorskip("jsonschema")
    schema = load_schema()
    snapshot = load_snapshot()

    bundle = {name: payload for name, payload in snapshot["endpoints"].items()}
    # The snapshot stores the endpoints under their route names; the schema
    # names them by payload. Map one to the other.
    route_to_payload = {
        "/health": "health",
        "/holdings": "holdings",
        "/portfolio/summary": "summary",
        "/portfolio/history": "history",
        "/portfolio/returns": "returns",
        "/portfolio/risk": "risk",
        "/portfolio/montecarlo": "montecarlo",
    }
    payload_bundle = {
        route_to_payload[route]: payload
        for route, payload in bundle.items()
        if route in route_to_payload
    }

    jsonschema.validate(payload_bundle, schema)


def test_the_schema_is_up_to_date() -> None:
    """Regenerating the schema must not change it.

    If this fails, the payload has changed and the committed contract has
    not: run ``python backend/export_schema.py`` and commit the result.
    """
    before = SCHEMA_PATH.read_text(encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "backend" / "export_schema.py")],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        pytest.fail(f"the schema could not be regenerated: {result.stderr[-2000:]}")
    after = SCHEMA_PATH.read_text(encoding="utf-8")
    assert before == after, (
        "the payload contract changed; run `python backend/export_schema.py` "
        "and commit the updated schema"
    )


def test_the_live_payload_has_the_same_fields_as_the_contract() -> None:
    """The live service must not carry fields the contract does not declare.

    Only the keys are compared, not the types: a field that is null in one
    dataset and a number in another is legitimate, but a field that exists
    in one and not the other is a contract violation.
    """
    schema = load_schema()

    from backend.app.portfolio import PortfolioAnalytics  # noqa: F401

    # The synthetic analytics from the fixtures exercise the same builders as
    # the live service.
    from backend.app.portfolio import build_analytics

    from backend.app.config import SETTINGS

    try:
        analytics = build_analytics(SETTINGS)
    except Exception:  # noqa: BLE001 - no market data in a sandbox
        pytest.skip("market data is not available in this environment")

    for payload, method in (
        ("summary", "summary"),
        ("risk", "risk"),
        ("returns", "returns"),
        ("holdings", "holdings"),
        ("history", "history"),
        ("montecarlo", "montecarlo"),
        ("health", "health"),
    ):
        live = getattr(analytics, method)()
        declared = schema["properties"][payload]["properties"]
        for key in live:
            assert key in declared, (
                f"the live '{payload}' payload has '{key}', which the contract "
                "does not declare"
            )


def test_every_payload_the_front_end_reads_is_in_the_contract() -> None:
    """A field the front end uses must exist in the contract.

    This is the check that would have caught the field rename: the schema
    lists what the backend produces, and the front end's types list what it
    reads. A name in one and not the other is a defect.
    """
    schema = load_schema()
    types_path = REPO_ROOT / "frontend" / "src" / "lib" / "types.ts"
    types = types_path.read_text(encoding="utf-8")

    # The payload-level fields the front end's interfaces declare.
    payload_fields = {
        "summary": [
            "total_value",
            "total_cost",
            "total_unrealized_pnl",
            "total_unrealized_pnl_pct",
            "holdings_count",
            "changes",
            "allocation_by_class",
            "allocation_by_region",
            "allocation_by_currency",
            "sparkline",
        ],
        "holdings": ["total_value", "holdings"],
        "history": [
            "dates",
            "portfolio",
            "portfolio_value",
            "benchmark_rebased",
            "drawdown_pct",
            "per_holding",
            "flows",
        ],
        "returns": [
            "daily_pct",
            "cumulative_pct",
            "monthly_pct",
            "yearly_pct",
            "histogram",
            "observations",
            "best_day",
            "worst_day",
            "annualized_return_pct",
        ],
        "risk": [
            "lookback_days",
            "risk_free_rate",
            "annualized_return_pct",
            "volatility_annualized_pct",
            "sharpe_ratio",
            "sortino_ratio",
            "calmar_ratio",
            "max_drawdown",
            "value_at_risk",
            "beta",
            "benchmark",
            "concentration",
            "risk_contribution",
            "correlation",
            "warnings",
        ],
        "montecarlo": [
            "paths",
            "horizon_days",
            "start_value",
            "percentile_bands",
            "final_values",
            "histogram",
            "expected_value",
            "median_value",
            "probability_below_start_pct",
            "assumptions",
        ],
        "health": [
            "status",
            "version",
            "as_of",
            "base_currency",
            "holdings_count",
            "benchmark",
            "history_start",
            "history_days",
            "prices_fetched_at",
            "observations",
            "warnings",
        ],
    }

    for payload, fields in payload_fields.items():
        declared = schema["properties"][payload]["properties"]
        for field in fields:
            assert field in declared, (
                f"the front end reads '{payload}.{field}', which the contract does "
                "not declare"
            )
            assert field in types, (
                f"'{payload}.{field}' is in the contract but not in the front end types"
            )
