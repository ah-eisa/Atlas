"""CSV / Broker Statement Import Wizard and Watchlist & Smart Alerts Engine."""

from __future__ import annotations

import csv
import io
import logging
from datetime import date
from typing import Any

from . import fixed_income, instruments, store
from .config import SETTINGS, Settings

logger = logging.getLogger(__name__)

# Column alias dictionary for automatic broker statement / CSV mapping
COLUMN_ALIASES: dict[str, list[str]] = {
    "kind": ["kind", "row_type", "record_type"],
    "ticker": ["ticker", "symbol", "instrument", "security", "asset", "underlying"],
    "name": ["name", "description", "security_name", "company", "asset_name"],
    "asset_class": ["asset_class", "assetcategory", "asset_category", "type", "class", "category"],
    "region": ["region", "country", "geography", "market"],
    "currency": ["currency", "ccy", "curr", "PriceCurrency"],
    "quantity": ["quantity", "shares", "units", "position", "qty"],
    "cost_basis_per_unit": [
        "cost_basis_per_unit",
        "cost_basis",
        "costbasisprice",
        "avg_price",
        "average_price",
        "price",
        "t. price",
        "trade_price",
        "unit_cost",
    ],
    "acquired": ["acquired", "date", "trade_date", "tradedate", "date/time", "executed_at", "open_date"],
    "order_type": ["order_type", "side", "action", "buy/sell", "transaction_type"],
    "amount": ["amount", "cash_amount", "net_amount", "proceeds"],
    "note": ["note", "notes", "comment", "memo"],
}


def _detect_mapping(headers: list[str], overrides: dict[str, str] | None = None) -> dict[str, str]:
    """Map canonical fields to actual CSV column names."""
    mapping: dict[str, str] = {}
    lower_to_actual = {h.strip().lower(): h for h in headers if h.strip()}

    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias.lower() in lower_to_actual:
                mapping[canonical] = lower_to_actual[alias.lower()]
                break

    if overrides:
        for k, v in overrides.items():
            if v and v in headers:
                mapping[k] = v
    return mapping


def _clean_date(raw: str | None) -> str:
    if not raw:
        return date.today().isoformat()
    cleaned = str(raw).strip().split(" ")[0].split(",")[0].split("T")[0]
    if "/" in cleaned:
        parts = cleaned.split("/")
        if len(parts) == 3:
            # Handle YYYY/MM/DD or MM/DD/YYYY
            if len(parts[0]) == 4:
                return f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"
            return f"{parts[2]}-{int(parts[0]):02d}-{int(parts[1]):02d}"
    if len(cleaned) == 8 and cleaned.isdigit():
        # IBKR YYYYMMDD format
        return f"{cleaned[:4]}-{cleaned[4:6]}-{cleaned[6:8]}"
    try:
        date.fromisoformat(cleaned)
        return cleaned
    except ValueError:
        return date.today().isoformat()


def _clean_float(raw: Any, default: float = 0.0) -> float:
    if raw is None:
        return default
    text = str(raw).strip().replace(",", "").replace("$", "").replace("€", "").replace("£", "")
    if not text:
        return default
    return float(text)


def preview_csv_import(
    csv_text: str,
    mapping_overrides: dict[str, str] | None = None,
    default_currency: str = "USD",
) -> dict[str, Any]:
    """Parse CSV text, auto-detect broker/ATLAS schema, and preview positions, trades & cash flows."""
    text = (csv_text or "").strip()
    if not text:
        raise ValueError("CSV content is empty.")

    sample = text[:2048]
    delimiter = ","
    for candidate in (",", ";", "\t"):
        if sample.count(candidate) > sample.count(delimiter):
            delimiter = candidate

    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    headers = list(reader.fieldnames or [])
    if not headers:
        raise ValueError("Could not detect CSV column headers.")

    mapping = _detect_mapping(headers, mapping_overrides)
    lower_headers = {h.strip().lower() for h in headers if h}

    if "kind" in lower_headers:
        detected_format = "atlas_combined"
    elif "t. price" in lower_headers or "costbasisprice" in lower_headers or "assetcategory" in lower_headers:
        detected_format = "ibkr_statement"
    elif "order_type" in mapping:
        detected_format = "broker_trades"
    else:
        detected_format = "generic_positions"

    positions: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    cash_flows: list[dict[str, Any]] = []
    warnings: list[str] = []
    errors: list[str] = []

    for idx, row in enumerate(reader, start=2):
        kind_col = mapping.get("kind")
        row_kind = (row.get(kind_col, "") if kind_col else "").strip().lower()

        if row_kind == "cash_flow":
            try:
                amt = _clean_float(row.get(mapping.get("amount", "amount")))
                dt = _clean_date(row.get(mapping.get("acquired", "date")))
                note = str(row.get(mapping.get("note", "note")) or "").strip()
                if amt != 0.0:
                    cash_flows.append({"occurred_on": dt, "amount": amt, "note": note})
            except Exception as exc:  # noqa: BLE001
                errors.append(f"Row {idx} (cash_flow): {exc}")
            continue

        ticker_col = mapping.get("ticker")
        ticker = (row.get(ticker_col, "") if ticker_col else "").strip().upper()
        if not ticker:
            continue

        order_col = mapping.get("order_type")
        raw_side = (row.get(order_col, "") if order_col else "").strip().upper()
        is_trade = row_kind == "trade" or raw_side in {"BUY", "SELL", "BOT", "SLD"}

        try:
            qty = _clean_float(row.get(mapping.get("quantity", "quantity")))
            price = _clean_float(row.get(mapping.get("cost_basis_per_unit", "cost_basis_per_unit")))
            dt = _clean_date(row.get(mapping.get("acquired", "acquired")))

            if is_trade:
                side = "SELL" if raw_side in {"SELL", "SLD"} or qty < 0 else "BUY"
                abs_qty = abs(qty)
                if abs_qty <= 0:
                    warnings.append(f"Row {idx} ({ticker}): skipped zero-quantity trade.")
                    continue
                trades.append(
                    {
                        "ticker": ticker,
                        "order_type": side,
                        "quantity": abs_qty,
                        "price": max(0.0, price),
                        "executed_at": dt,
                        "notes": str(row.get(mapping.get("note", ""), "") or f"Imported ({detected_format})").strip(),
                    }
                )
            else:
                if qty <= 0:
                    warnings.append(f"Row {idx} ({ticker}): skipped non-positive position quantity ({qty}).")
                    continue
                name_col = mapping.get("name")
                class_col = mapping.get("asset_class")
                region_col = mapping.get("region")
                ccy_col = mapping.get("currency")

                raw_class = (row.get(class_col, "") if class_col else "").strip() or "Stock"
                if raw_class.upper() in {"STK", "EQUITY", "EQUITIES"}:
                    raw_class = "Stock"
                elif raw_class.upper() in {"BOND", "FIXED INCOME", "BILL", "NOTE"}:
                    raw_class = "Bond"

                positions.append(
                    {
                        "ticker": ticker,
                        "name": (row.get(name_col, "") if name_col else "").strip() or ticker,
                        "asset_class": raw_class,
                        "region": ((row.get(region_col, "") if region_col else "").strip() or "US"),
                        "currency": ((row.get(ccy_col, "") if ccy_col else "").strip().upper() or default_currency),
                        "quantity": qty,
                        "cost_basis_per_unit": max(0.0, price),
                        "acquired": dt,
                    }
                )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Row {idx} ({ticker}): {exc}")

    return {
        "detected_format": detected_format,
        "delimiter": delimiter,
        "headers": headers,
        "mapping": mapping,
        "positions": positions,
        "trades": trades,
        "cash_flows": cash_flows,
        "warnings": warnings,
        "errors": errors,
        "summary": {
            "positions_count": len(positions),
            "trades_count": len(trades),
            "cash_flows_count": len(cash_flows),
        },
    }


def commit_csv_import(
    csv_text: str,
    mode: str = "merge",
    mapping_overrides: dict[str, str] | None = None,
    settings: Settings = SETTINGS,
    portfolio_id: int = store.DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    """Commit parsed CSV positions, trades, and cash flows into the active portfolio."""
    base_ccy = store.get_base_currency(settings, portfolio_id)
    preview = preview_csv_import(csv_text, mapping_overrides, default_currency=base_ccy)

    imported_positions = 0
    imported_trades = 0
    imported_flows = 0
    warnings = list(preview["warnings"])

    if mode == "replace" and preview["positions"]:
        imported_positions = store.replace_all(
            preview["positions"],
            base_currency=base_ccy,
            settings=settings,
            portfolio_id=portfolio_id,
        )
    else:
        existing = {
            h["ticker"].upper(): h for h in store.list_holdings(settings, portfolio_id)
        }
        for pos in preview["positions"]:
            t = pos["ticker"].upper()
            try:
                if t in existing:
                    cur = existing[t]
                    new_qty = float(cur["quantity"]) + float(pos["quantity"])
                    new_cost = (
                        float(cur["quantity"]) * float(cur["cost_basis_per_unit"])
                        + float(pos["quantity"]) * float(pos["cost_basis_per_unit"])
                    ) / new_qty
                    store.update_holding(
                        cur["id"],
                        {
                            **pos,
                            "quantity": new_qty,
                            "cost_basis_per_unit": new_cost,
                        },
                        settings=settings,
                        portfolio_id=portfolio_id,
                    )
                else:
                    created = store.create_holding(pos, settings=settings, portfolio_id=portfolio_id)
                    existing[t] = created
                imported_positions += 1
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Position {t}: {exc}")

    for trade in preview["trades"]:
        try:
            store.place_order(trade, settings=settings, portfolio_id=portfolio_id)
            imported_trades += 1
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Trade {trade['ticker']} ({trade['order_type']}): {exc}")

    for flow in preview["cash_flows"]:
        try:
            store.create_cash_flow(flow, settings=settings, portfolio_id=portfolio_id)
            imported_flows += 1
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Cash flow ({flow['occurred_on']}): {exc}")

    return {
        "detected_format": preview["detected_format"],
        "mode": mode,
        "imported_positions": imported_positions,
        "imported_trades": imported_trades,
        "imported_cash_flows": imported_flows,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Watchlists & Smart Alerts Engine
# ---------------------------------------------------------------------------

FALLBACK_PRICES: dict[str, tuple[float, str, str]] = {
    "AAPL": (228.50, "USD", "Stock"),
    "MSFT": (445.20, "USD", "Stock"),
    "NVDA": (138.40, "USD", "Stock"),
    "AMZN": (210.15, "USD", "Stock"),
    "GOOGL": (182.90, "USD", "Stock"),
    "META": (592.00, "USD", "Stock"),
    "TSLA": (258.30, "USD", "Stock"),
    "BRK-B": (456.80, "USD", "Stock"),
    "SPY": (584.10, "USD", "ETF"),
    "QQQ": (498.60, "USD", "ETF"),
    "VWCE.DE": (132.40, "EUR", "ETF"),
    "AGGH.AS": (4.88, "EUR", "Bond"),
    "BTC-USD": (89400.0, "USD", "Crypto"),
    "GLD": (254.20, "USD", "Commodity"),
}


def get_watchlist_and_alerts(
    settings: Settings = SETTINGS,
    portfolio_id: int = store.DEFAULT_PORTFOLIO_ID,
    analytics: Any | None = None,
) -> dict[str, Any]:
    """Return enriched watchlist items, custom alert rules, and live triggered smart alerts."""
    raw_watchlist = store.list_watchlist(settings, portfolio_id)
    if not raw_watchlist:
        # Seed default institutional watchlist items on first access if empty
        for default_item in (
            {
                "ticker": "NVDA",
                "name": "NVIDIA Corp.",
                "target_buy_price": 125.0,
                "target_sell_price": 165.0,
                "notes": "AI datacenter GPU leader — watch Q3 10-Q margins",
            },
            {
                "ticker": "MSFT",
                "name": "Microsoft Corp.",
                "target_buy_price": 410.0,
                "target_sell_price": 490.0,
                "notes": "Core cloud & enterprise software compounder",
            },
            {
                "ticker": "AAPL",
                "name": "Apple Inc.",
                "target_buy_price": 210.0,
                "target_sell_price": 255.0,
                "notes": "Consumer ecosystem & services cash flow",
            },
        ):
            try:
                store.upsert_watchlist_item(default_item, settings, portfolio_id)
            except Exception:  # noqa: BLE001
                pass
        raw_watchlist = store.list_watchlist(settings, portfolio_id)

    held_map: dict[str, Any] = {}
    if analytics is not None:
        for p in analytics.positions:
            held_map[p.ticker.upper()] = p

    enriched_watchlist: list[dict[str, Any]] = []
    triggered_alerts: list[dict[str, Any]] = []

    for item in raw_watchlist:
        ticker = item["ticker"].upper()
        held = held_map.get(ticker)
        if held is not None:
            last_price = float(held.price_native)
            currency = held.currency
            asset_class = held.asset_class
            in_portfolio = True
            weight_pct = float(held.allocation_pct)
        elif ticker in FALLBACK_PRICES:
            last_price, currency, asset_class = FALLBACK_PRICES[ticker]
            in_portfolio = False
            weight_pct = 0.0
        else:
            try:
                info = instruments.lookup(ticker)
                last_price = float(info.last_price or 100.0)
                currency = info.currency
                asset_class = info.asset_class
            except Exception:  # noqa: BLE001
                last_price, currency, asset_class = (100.0, "USD", "Stock")
            in_portfolio = False
            weight_pct = 0.0

        t_buy = item["target_buy_price"]
        t_sell = item["target_sell_price"]
        status = "WATCHING"
        distance_to_buy_pct: float | None = None
        distance_to_sell_pct: float | None = None

        if t_buy is not None and t_buy > 0 and last_price > 0:
            distance_to_buy_pct = round((last_price - float(t_buy)) / float(t_buy), 4)
            if last_price <= float(t_buy):
                status = "BUY_ZONE"
                triggered_alerts.append(
                    {
                        "id": f"wl-buy-{ticker}",
                        "severity": "high",
                        "category": "Watchlist Target",
                        "ticker": ticker,
                        "title": f"{ticker} reached Target Buy Zone",
                        "message": f"{ticker} is trading at {last_price:.2f} {currency} (at or below target buy {float(t_buy):.2f} {currency}).",
                    }
                )

        if t_sell is not None and t_sell > 0 and last_price > 0:
            distance_to_sell_pct = round((float(t_sell) - last_price) / last_price, 4)
            if last_price >= float(t_sell):
                status = "TAKE_PROFIT"
                triggered_alerts.append(
                    {
                        "id": f"wl-sell-{ticker}",
                        "severity": "medium",
                        "category": "Watchlist Target",
                        "ticker": ticker,
                        "title": f"{ticker} reached Target Take-Profit Price",
                        "message": f"{ticker} is trading at {last_price:.2f} {currency} (at or above target sell {float(t_sell):.2f} {currency}).",
                    }
                )

        enriched_watchlist.append(
            {
                **item,
                "last_price": round(last_price, 2),
                "currency": currency,
                "asset_class": asset_class,
                "in_portfolio": in_portfolio,
                "portfolio_weight": round(weight_pct, 4),
                "status": status,
                "distance_to_buy_pct": distance_to_buy_pct,
                "distance_to_sell_pct": distance_to_sell_pct,
            }
        )

    # Evaluate automated portfolio & macro risk guardrails
    if analytics is not None:
        risk = analytics.risk()
        max_dd = float(risk.get("max_drawdown", {}).get("pct") or 0.0)
        var_95 = float(risk.get("value_at_risk", {}).get("95", {}).get("historical_pct") or 0.0)
        largest = max(analytics.positions, key=lambda p: p.allocation_pct, default=None)

        if max_dd <= -0.10:
            triggered_alerts.append(
                {
                    "id": "guard-dd",
                    "severity": "high" if max_dd <= -0.20 else "medium",
                    "category": "Drawdown Guardrail",
                    "ticker": None,
                    "title": f"Historical Max Drawdown: {max_dd * 100:.2f}%",
                    "message": f"Portfolio maximum drawdown ({max_dd * 100:.2f}%) breached the -10.0% institutional monitoring threshold.",
                }
            )
        if var_95 <= -0.02:
            triggered_alerts.append(
                {
                    "id": "guard-var",
                    "severity": "medium",
                    "category": "VaR Guardrail",
                    "ticker": None,
                    "title": f"95% Daily VaR Breach: {var_95 * 100:.2f}%",
                    "message": f"1-day 95% Value-at-Risk ({var_95 * 100:.2f}%) exceeds the -2.00% daily tail-risk budget.",
                }
            )
        if largest is not None and float(largest.allocation_pct) >= 0.25:
            triggered_alerts.append(
                {
                    "id": "guard-conc",
                    "severity": "high",
                    "category": "Concentration Alert",
                    "ticker": largest.ticker,
                    "title": f"Single-Name Concentration: {largest.ticker} ({largest.allocation_pct * 100:.1f}%)",
                    "message": f"{largest.ticker} represents {largest.allocation_pct * 100:.1f}% of NAV, exceeding the 25% single-position limit.",
                }
            )

    # Yield Curve / Rates Alert
    try:
        yc = fixed_income.get_fixed_income_service().get_yield_curve()
        if yc.spread_10y_2y_bps < 0:
            triggered_alerts.append(
                {
                    "id": "macro-yc-inv",
                    "severity": "high",
                    "category": "Macro & Rates",
                    "ticker": "US10Y-2Y",
                    "title": f"US Treasury 10Y-2Y Curve Inverted ({yc.spread_10y_2y_bps:.0f} bps)",
                    "message": f"10Y yield ({yc.us10y_yield:.2f}%) is below 2Y yield ({yc.us2y_yield:.2f}%), signaling recessionary rate expectations.",
                }
            )
    except Exception:  # noqa: BLE001
        pass

    # Evaluate Custom User Alert Rules
    custom_rules = store.list_alert_rules(settings, portfolio_id)
    for rule in custom_rules:
        if not rule["enabled"]:
            continue
        metric = rule["metric"]
        threshold = float(rule["threshold"])
        r_ticker = (rule["ticker"] or "").upper()

        if metric in {"price_above", "price_below"} and r_ticker:
            # Find price from watchlist or holdings or fallback
            wl_match = next((w for w in enriched_watchlist if w["ticker"].upper() == r_ticker), None)
            price_val = (
                float(wl_match["last_price"])
                if wl_match
                else float(FALLBACK_PRICES.get(r_ticker, (100.0, "USD", "Stock"))[0])
            )
            if metric == "price_above" and price_val >= threshold:
                triggered_alerts.append(
                    {
                        "id": f"rule-{rule['id']}",
                        "severity": "medium",
                        "category": "Custom Rule",
                        "ticker": r_ticker,
                        "title": rule["label"] or f"{r_ticker} >= {threshold}",
                        "message": f"{r_ticker} price ({price_val:.2f}) is at or above alert threshold ({threshold:.2f}).",
                    }
                )
            elif metric == "price_below" and price_val <= threshold:
                triggered_alerts.append(
                    {
                        "id": f"rule-{rule['id']}",
                        "severity": "high",
                        "category": "Custom Rule",
                        "ticker": r_ticker,
                        "title": rule["label"] or f"{r_ticker} <= {threshold}",
                        "message": f"{r_ticker} price ({price_val:.2f}) is at or below alert threshold ({threshold:.2f}).",
                    }
                )
        elif metric == "drawdown_pct" and analytics is not None:
            dd = float(analytics.risk().get("max_drawdown", {}).get("pct") or 0.0) * 100.0
            if dd <= threshold:
                triggered_alerts.append(
                    {
                        "id": f"rule-{rule['id']}",
                        "severity": "high",
                        "category": "Custom Rule",
                        "ticker": None,
                        "title": rule["label"] or f"Drawdown <= {threshold:.1f}%",
                        "message": f"Portfolio max drawdown ({dd:.2f}%) breached custom rule threshold ({threshold:.2f}%).",
                    }
                )

    return {
        "watchlist": enriched_watchlist,
        "rules": custom_rules,
        "triggered_alerts": triggered_alerts,
    }
