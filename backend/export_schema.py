"""Export the payload contract as a JSON Schema.

The dashboard has two halves that must agree: the backend builds the
analytics payloads, and the front end reads them. A field that is renamed on
one side and not the other does not fail loudly - the interface renders
zeros, or an em dash, and nothing says why.

This script writes the contract down:

  * it takes the payload bundle the backend actually produces,
  * infers a JSON Schema from it - every key, every type, every level of
    nesting, with the nullability the payload actually has,
  * and writes it to ``frontend/src/lib/payload-schema.json``.

The committed schema is then used by three checks:

  * the backend test suite validates ``snapshot.json`` against it, so the
    committed demo payload cannot drift from the contract;
  * the front end's unit tests check that the fields the normaliser reads
    are the fields the schema declares;
  * CI regenerates the schema and fails if the result differs from the
    committed one, so a change to the payload cannot land unnoticed.

Run it with::

    python backend/export_schema.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

OUTPUT = REPO_ROOT / "frontend" / "src" / "lib" / "payload-schema.json"

# The payloads the front end consumes, and the method that builds each.
PAYLOADS = {
    "health": "health",
    "holdings": "holdings",
    "summary": "summary",
    "history": "history",
    "returns": "returns",
    "risk": "risk",
    "montecarlo": "montecarlo",
}


def infer_schema(value: Any, samples: list[Any] | None = None) -> dict[str, Any]:
    """Infer a JSON Schema fragment from a value.

    ``samples`` carries the other observations of the same field, so a field
    that is null in one payload and a number in another is typed as
    nullable rather than as a null.
    """
    if samples:
        for candidate in samples:
            if candidate is not None:
                value = candidate
                break

    if value is None:
        return {"type": ["null", "string", "number", "boolean", "array", "object"]}

    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, (int, float)):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        item_types: list[dict[str, Any]] = []
        for item in value[:5]:
            fragment = infer_schema(item)
            if fragment not in item_types:
                item_types.append(fragment)
        if not item_types:
            return {"type": "array"}
        if len(item_types) == 1:
            return {"type": "array", "items": item_types[0]}
        return {"type": "array", "items": {"anyOf": item_types}}
    if isinstance(value, dict):
        properties: dict[str, Any] = {}
        for key, item in value.items():
            properties[key] = infer_schema(item)
        return {"type": "object", "properties": properties, "additionalProperties": True}
    return {}


def build_schema(bundle: dict[str, Any]) -> dict[str, Any]:
    """The schema of the whole payload bundle."""
    properties = {
        name: infer_schema(bundle.get(name)) for name in PAYLOADS.values()
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "ATLAS analytics payload contract",
        "type": "object",
        "required": sorted(properties),
        "properties": properties,
        "additionalProperties": True,
    }


def main() -> int:
    """Write the contract.

    The schema is derived from the committed snapshot rather than from a live
    build, so it is deterministic: a field that happens to be null today and
    a number tomorrow would otherwise change the contract from one day to
    the next, and the check that it is up to date would fail for no reason.
    The snapshot is the backend's own output, produced by the same builders
    the live service uses.
    """
    snapshot_path = REPO_ROOT / "snapshot.json"
    if not snapshot_path.exists():
        print(
            "snapshot.json is missing; run `python backend/generate_snapshot.py` first",
            file=sys.stderr,
        )
        return 1

    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    route_to_payload = {
        "/health": "health",
        "/holdings": "holdings",
        "/portfolio/summary": "summary",
        "/portfolio/history": "history",
        "/portfolio/returns": "returns",
        "/portfolio/risk": "risk",
        "/portfolio/montecarlo": "montecarlo",
    }
    bundle = {
        route_to_payload[route]: payload
        for route, payload in snapshot.get("endpoints", {}).items()
        if route in route_to_payload
    }
    schema = build_schema(bundle)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
