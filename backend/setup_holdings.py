"""Build the portfolio without hand-editing JSON.

Two ways in:

    python backend/setup_holdings.py                 # interactive
    python backend/setup_holdings.py --csv mine.csv  # bulk import

Both validate every ticker against Yahoo Finance before writing, and fill in
whatever they can on your behalf: the instrument's name, its quote currency,
its asset class, and - if you give a purchase date - the actual closing price
on that date as your cost basis.

By default the positions are written to ``holdings.json`` *and* imported into
the SQLite store the application reads. Use ``--no-db`` to only write the JSON
file (for example to produce a fresh demo snapshot on a machine that should not
create a database).

The CSV needs a header row and at least ``ticker`` and ``quantity``:

    ticker,quantity,cost_basis,acquired
    AAPL,22,,2026-01-15
    IWDA.AS,110,95.40,2025-11-14
    BTC-USD,0.15,,2025-11-14

``cost_basis`` is in the instrument's own currency; leave it blank to use the
close on ``acquired``. Leave ``acquired`` blank to use today.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import shutil
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import yfinance as yf

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.app.config import SETTINGS  # noqa: E402
from backend.app import store  # noqa: E402

logger = logging.getLogger("setup_holdings")

# yfinance quoteType -> the asset_class label used for grouping in the UI.
QUOTE_TYPE_TO_CLASS = {
    "EQUITY": "Stock",
    "ETF": "ETF",
    "MUTUALFUND": "Fund",
    "CRYPTOCURRENCY": "Crypto",
    "INDEX": "Index",
    "CURRENCY": "Cash",
}

# Coarse geographic buckets. Anything unmatched falls back to the raw country.
COUNTRY_TO_REGION = {
    "United States": "US",
    "Canada": "US",
    "Germany": "Europe",
    "Netherlands": "Europe",
    "France": "Europe",
    "Switzerland": "Europe",
    "United Kingdom": "Europe",
    "Ireland": "Europe",
    "Italy": "Europe",
    "Spain": "Europe",
    "Sweden": "Europe",
    "China": "China",
    "Hong Kong": "China",
    "Taiwan": "Asia",
    "Japan": "Asia",
    "South Korea": "Asia",
    "India": "Asia",
}


@dataclass
class Lookup:
    """What Yahoo Finance knows about a ticker."""

    ticker: str
    name: str
    currency: str
    price: float
    asset_class: str
    region: str | None


def look_up(ticker: str) -> Lookup:
    """Fetch and normalise the metadata needed to describe a holding.

    Raises:
        ValueError: if the symbol is unknown or has no price.
    """
    handle = yf.Ticker(ticker)

    try:
        fast = handle.fast_info
        price = float(fast["lastPrice"])
        currency = str(fast["currency"])
    except Exception as exc:  # noqa: BLE001 - any failure means "unusable symbol"
        raise ValueError(f"{ticker!r} not found on Yahoo Finance") from exc

    # `.info` is richer but slower and flakier; never let it be fatal.
    info: dict[str, Any] = {}
    try:
        info = handle.info or {}
    except Exception:  # noqa: BLE001
        logger.debug("no extended info for %s", ticker)

    quote_type = str(info.get("quoteType", "")).upper()
    asset_class = QUOTE_TYPE_TO_CLASS.get(quote_type, "Stock")

    if asset_class == "Crypto":
        region = None
    else:
        country = info.get("country")
        region = COUNTRY_TO_REGION.get(str(country), str(country) if country else None)

    return Lookup(
        ticker=ticker,
        name=str(info.get("longName") or info.get("shortName") or ticker),
        currency=currency,
        price=price,
        asset_class=asset_class,
        region=region,
    )


def close_on(ticker: str, day: str) -> float | None:
    """Closing price of ``ticker`` on ``day`` (or the last close before it)."""
    stamp = pd.Timestamp(day)
    history = yf.download(
        ticker,
        start=(stamp - pd.Timedelta(days=10)).strftime("%Y-%m-%d"),
        end=(stamp + pd.Timedelta(days=1)).strftime("%Y-%m-%d"),
        auto_adjust=True,
        progress=False,
    )
    if history is None or history.empty:
        return None
    closes = history["Close"]
    series = closes.iloc[:, 0] if hasattr(closes, "columns") else closes
    return float(series.dropna().iloc[-1])


def build_entry(
    ticker: str,
    quantity: float,
    cost_basis: float | None,
    acquired: str | None,
    lookup: Lookup,
) -> dict[str, Any]:
    """Assemble one holdings.json record, resolving the cost basis if absent."""
    acquired = acquired or date.today().isoformat()

    if cost_basis is None:
        cost_basis = close_on(ticker, acquired)
        if cost_basis is None:
            logger.warning("%s: no close for %s; using the latest price", ticker, acquired)
            cost_basis = lookup.price

    return {
        "ticker": lookup.ticker,
        "name": lookup.name,
        "asset_class": lookup.asset_class,
        "region": lookup.region,
        "currency": lookup.currency,
        "quantity": round(float(quantity), 8),
        "cost_basis_per_unit": round(float(cost_basis), 4),
        "acquired": acquired,
    }


# --------------------------------------------------------------------------
# Input modes
# --------------------------------------------------------------------------


def ask(prompt: str, default: str | None = None) -> str:
    """Prompt with an optional default shown in brackets."""
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or (default or "")


def ask_float(prompt: str, default: float | None = None) -> float:
    while True:
        raw = ask(prompt, None if default is None else str(default))
        try:
            return float(raw.replace(",", ""))
        except ValueError:
            print("  Please enter a number.")


def interactive() -> tuple[str, list[dict[str, Any]]]:
    """Walk the user through their positions one at a time."""
    print("\nPortfolio setup — enter one position at a time, blank ticker to finish.\n")
    base_currency = ask("Reporting currency", SETTINGS.base_currency).upper()

    entries: list[dict[str, Any]] = []
    while True:
        ticker = ask("\nTicker (blank to finish)").strip()
        if not ticker:
            break

        try:
            lookup = look_up(ticker)
        except ValueError as exc:
            print(f"  {exc}. Check the symbol on finance.yahoo.com and try again.")
            continue

        print(f"  {lookup.name} · {lookup.asset_class} · {lookup.price:,.2f} {lookup.currency}")

        quantity = ask_float("  Quantity")
        acquired = ask("  Purchase date (YYYY-MM-DD)", date.today().isoformat())
        basis_raw = ask(f"  Cost per unit in {lookup.currency} (blank = close on that date)", "")
        cost_basis = float(basis_raw.replace(",", "")) if basis_raw else None

        lookup.asset_class = ask("  Asset class", lookup.asset_class)
        region_default = lookup.region or ""
        region = ask("  Region (blank for none)", region_default)
        lookup.region = region or None

        entry = build_entry(ticker, quantity, cost_basis, acquired, lookup)
        entries.append(entry)
        value = entry["quantity"] * lookup.price
        print(f"  Added {entry['ticker']}: {value:,.2f} {lookup.currency} at today's price")

    return base_currency, entries


def from_csv(path: Path, base_currency: str) -> tuple[str, list[dict[str, Any]]]:
    """Import positions in bulk from a spreadsheet export."""
    rows = list(csv.DictReader(path.read_text(encoding="utf-8-sig").splitlines()))
    if not rows:
        raise ValueError(f"{path}: no rows found")

    missing = {"ticker", "quantity"} - {key.lower() for key in rows[0]}
    if missing:
        raise ValueError(f"{path}: missing required column(s): {', '.join(sorted(missing))}")

    entries: list[dict[str, Any]] = []
    for number, row in enumerate(rows, start=2):
        clean = {(key or "").strip().lower(): (value or "").strip() for key, value in row.items()}
        ticker = clean.get("ticker", "")
        if not ticker:
            continue

        try:
            lookup = look_up(ticker)
        except ValueError as exc:
            raise ValueError(f"{path} line {number}: {exc}") from exc

        if clean.get("name"):
            lookup.name = clean["name"]
        if clean.get("asset_class"):
            lookup.asset_class = clean["asset_class"]
        if clean.get("region"):
            lookup.region = clean["region"]

        entries.append(
            build_entry(
                ticker=ticker,
                quantity=float(clean["quantity"].replace(",", "")),
                cost_basis=float(clean["cost_basis"].replace(",", "")) if clean.get("cost_basis") else None,
                acquired=clean.get("acquired") or None,
                lookup=lookup,
            )
        )
        print(f"  {lookup.ticker:<12} {lookup.name}")

    return base_currency, entries


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def write_holdings(
    path: Path,
    base_currency: str,
    entries: Iterable[dict[str, Any]],
    *,
    write_db: bool = True,
) -> None:
    """Write holdings.json (backing up any existing file) and optionally import."""
    entries = list(entries)
    if not entries:
        print("\nNo positions entered; nothing written.")
        return

    if path.exists():
        backup = path.with_suffix(f".backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
        shutil.copy2(path, backup)
        print(f"\nExisting holdings backed up to {backup.name}")

    document = {
        "base_currency": base_currency,
        "holdings": entries,
    }
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} positions to {path}")

    if write_db:
        store.init_db(SETTINGS)
        store.replace_all(entries, base_currency, SETTINGS)
        print(f"Imported {len(entries)} positions into {SETTINGS.db_path}")

    print("\nNext:  python backend/generate_snapshot.py  or  uvicorn backend.app.api:app --port 8000")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--csv", type=Path, help="import positions from a CSV file")
    parser.add_argument(
        "--base-currency",
        default=SETTINGS.base_currency,
        help=f"reporting currency for CSV imports (default: {SETTINGS.base_currency})",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=SETTINGS.holdings_path,
        help=f"output path (default: {SETTINGS.holdings_path})",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        help="only write the JSON file; do not import into SQLite",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)

    try:
        if args.csv:
            base_currency, entries = from_csv(args.csv, args.base_currency.upper())
        else:
            base_currency, entries = interactive()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled; nothing written.")
        return 1
    except ValueError as exc:
        print(f"\nError: {exc}")
        return 1

    write_holdings(args.output, base_currency, entries, write_db=not args.no_db)
    return 0


if __name__ == "__main__":
    sys.exit(main())
