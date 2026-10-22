"""Portfolio Lab: stress testing, Brinson-Fachler attribution and the X-Ray.

Three questions a risk committee asks that a volatility number cannot answer:

* *What happens to this book if X happens?*           -> :func:`stress_report`
* *Why did we beat (or lag) the benchmark?*           -> :func:`attribution_report`
* *Where is the risk really, and what overlaps?*      -> :func:`xray_report`

Methodology notes (also returned in each payload, so the UI can show them):

Stress
    Each position is assigned **one** primary risk factor - equity, rates,
    gold or crypto - so no move is counted twice. Its price response is
    ``sensitivity x factor shock``: the equity beta for equities (regressed on
    the benchmark in the instrument's own currency), minus modified duration
    for bonds, and 1.0 for gold and crypto. A currency move is layered on top
    for positions quoted in a currency other than the base. This is a
    first-order (delta) model: no convexity, no sector or credit factors, and
    cross-currency pairs that do not involve the USD are not modelled. The
    historical scenarios apply *stylised* factor moves measured over the
    named window; they are not a replay of the holdings' own price history,
    which usually does not reach back far enough.

Attribution
    Brinson-Fachler, single period, buy-and-hold from the window start:
    ``allocation_i = (wp_i - wb_i) (rb_i - Rb)``,
    ``selection_i  = wb_i (rp_i - rb_i)`` and
    ``interaction_i = (wp_i - wb_i)(rp_i - rb_i)``. The three effects sum
    exactly to ``Rp - Rb``. Because the book's own return is time-weighted and
    this one is buy-and-hold, the two can differ; the payload reports both.

X-Ray
    Concentration, exposure and *statistical* overlap. Overlap is inferred
    from return correlation, not from look-through fund holdings, and the
    payload says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

import numpy as np
import pandas as pd

from . import metrics
from .data import normalise_currency
from .serialize import json_safe, round_money, round_ratio

# --------------------------------------------------------------------------
# Stress: scenarios
# --------------------------------------------------------------------------

DEFAULT_BOND_DURATION: float = 6.0
"""Modified duration assumed for a bond holding when none is supplied."""

CRYPTO_EQUITY_MULTIPLE: float = 2.0
"""Crypto shock when a scenario does not state one: this many times equity."""

MIN_BETA_OBSERVATIONS: int = 60
"""Below this many overlapping daily returns a beta is not trusted (1.0 used)."""

GOLD_TICKERS: frozenset[str] = frozenset(
    {"GLD", "IAU", "GLDM", "SGOL", "PHYS", "GC=F", "XAUUSD=X", "GOLD"}
)


@dataclass(frozen=True)
class Shock:
    """A set of simultaneous market moves. ``*_pct`` fields are fractions."""

    equity_pct: float = 0.0
    rates_bps: float = 0.0
    usd_pct: float = 0.0
    gold_pct: float = 0.0
    crypto_pct: float | None = None

    @property
    def resolved_crypto_pct(self) -> float:
        if self.crypto_pct is not None:
            return self.crypto_pct
        return self.equity_pct * CRYPTO_EQUITY_MULTIPLE


@dataclass(frozen=True)
class Scenario:
    key: str
    name: str
    description: str
    window: str
    shock: Shock
    kind: str = "historical"  # historical | parametric


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "gfc_2008",
        "Global Financial Crisis",
        "Lehman collapse to the March 2009 low: equities halve, Treasuries rally, "
        "the dollar and gold are bid.",
        "Sep 2008 - Mar 2009",
        Shock(equity_pct=-0.44, rates_bps=-100, usd_pct=0.14, gold_pct=0.20),
    ),
    Scenario(
        "covid_2020",
        "COVID crash",
        "The fastest 30% drawdown on record: a liquidity scramble that hit "
        "everything except the dollar and Treasuries.",
        "19 Feb - 23 Mar 2020",
        Shock(equity_pct=-0.34, rates_bps=-80, usd_pct=0.03, gold_pct=-0.03, crypto_pct=-0.50),
    ),
    Scenario(
        "rates_2022",
        "2022 rates shock",
        "Inflation forces the fastest hiking cycle in forty years: stocks and "
        "bonds fall together, the dollar surges.",
        "Jan - Oct 2022",
        Shock(equity_pct=-0.25, rates_bps=250, usd_pct=0.15, gold_pct=-0.08, crypto_pct=-0.60),
    ),
    Scenario(
        "rates_up_100",
        "Rates +100 bps",
        "A parallel upward shift in yields with nothing else moving. Isolates "
        "the bond book's duration risk.",
        "Instant shock",
        Shock(rates_bps=100),
        kind="parametric",
    ),
    Scenario(
        "rates_down_100",
        "Rates -100 bps",
        "A parallel downward shift in yields.",
        "Instant shock",
        Shock(rates_bps=-100),
        kind="parametric",
    ),
    Scenario(
        "equity_down_20",
        "Equities -20%",
        "A bear-market move in the benchmark index.",
        "Instant shock",
        Shock(equity_pct=-0.20),
        kind="parametric",
    ),
    Scenario(
        "usd_up_10",
        "USD +10%",
        "A broad dollar rally. Hurts non-USD assets for a USD-based investor "
        "and helps USD assets for everyone else.",
        "Instant shock",
        Shock(usd_pct=0.10),
        kind="parametric",
    ),
)

SCENARIO_INDEX: dict[str, Scenario] = {scenario.key: scenario for scenario in SCENARIOS}


def scenario_catalogue() -> list[dict[str, Any]]:
    """The preset scenarios, for the UI's picker."""
    return [
        {
            "key": s.key,
            "name": s.name,
            "description": s.description,
            "window": s.window,
            "kind": s.kind,
            "shock": {
                "equity_pct": s.shock.equity_pct,
                "rates_bps": s.shock.rates_bps,
                "usd_pct": s.shock.usd_pct,
                "gold_pct": s.shock.gold_pct,
                "crypto_pct": s.shock.resolved_crypto_pct,
            },
        }
        for s in SCENARIOS
    ]


# --------------------------------------------------------------------------
# Stress: engine
# --------------------------------------------------------------------------


def classify_factor(asset_class: str, ticker: str, name: str) -> str:
    """The single risk factor a position is exposed to in the stress model."""
    kind = (asset_class or "").strip().lower()
    if kind == "crypto":
        return "crypto"
    if kind == "bond":
        return "rates"
    if ticker.upper() in GOLD_TICKERS or "gold" in (name or "").lower():
        return "gold"
    return "equity"


def holding_betas(
    prices_native: pd.DataFrame,
    benchmark: pd.Series,
    min_observations: int = MIN_BETA_OBSERVATIONS,
) -> dict[str, float]:
    """Beta of each holding to the benchmark, in the holding's own currency.

    Native prices are used on purpose: a base-currency return already contains
    the currency move, which the stress model applies separately. A holding
    with too little overlapping history gets a beta of 1.0 rather than a noisy
    estimate.
    """
    bench = benchmark.astype(float).pct_change(fill_method=None)
    result: dict[str, float] = {}
    for ticker in prices_native.columns:
        returns = prices_native[ticker].astype(float).pct_change(fill_method=None)
        joined = pd.concat([returns, bench], axis=1, join="inner").dropna()
        if len(joined) < min_observations:
            result[ticker] = 1.0
            continue
        variance = float(joined.iloc[:, 1].var(ddof=1))
        if variance <= 0.0:
            result[ticker] = 1.0
            continue
        result[ticker] = float(joined.iloc[:, 0].cov(joined.iloc[:, 1]) / variance)
    return result


def _fx_move(currency: str, base: str, usd_pct: float) -> float:
    """Change in a position's base-currency value caused by a USD move."""
    code = normalise_currency(currency)[0]
    if code == base or usd_pct == 0.0:
        return 0.0
    if code == "USD":
        return usd_pct
    if base == "USD":
        return 1.0 / (1.0 + usd_pct) - 1.0
    return 0.0  # a cross that does not involve the USD is not modelled


def stress_positions(
    positions: Iterable[Any],
    betas: dict[str, float],
    base_currency: str,
    shock: Shock,
    durations: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Apply one shock to every position and aggregate the result."""
    durations = durations or {}
    factor_shock = {
        "equity": shock.equity_pct,
        "rates": shock.rates_bps / 10_000.0,
        "gold": shock.gold_pct,
        "crypto": shock.resolved_crypto_pct,
    }

    rows: list[dict[str, Any]] = []
    total_value = 0.0
    total_pnl = 0.0
    by_factor: dict[str, float] = {}
    by_asset_class: dict[str, float] = {}
    fx_pnl_total = 0.0

    for position in positions:
        factor = classify_factor(position.asset_class, position.ticker, position.name)
        if factor == "equity":
            sensitivity = float(betas.get(position.ticker, 1.0))
        elif factor == "rates":
            sensitivity = -float(durations.get(position.ticker, DEFAULT_BOND_DURATION))
        else:  # gold, crypto: one-for-one with their own factor
            sensitivity = 1.0

        price_move = sensitivity * factor_shock[factor]
        fx_move = _fx_move(position.currency, base_currency, shock.usd_pct)
        total_move = max((1.0 + price_move) * (1.0 + fx_move) - 1.0, -1.0)
        value = float(position.value_base)
        pnl = value * total_move
        fx_pnl = value * ((1.0 + price_move) * fx_move)

        total_value += value
        total_pnl += pnl
        fx_pnl_total += fx_pnl
        by_factor[factor] = by_factor.get(factor, 0.0) + pnl
        bucket = position.asset_class or "Unclassified"
        by_asset_class[bucket] = by_asset_class.get(bucket, 0.0) + pnl

        rows.append(
            {
                "ticker": position.ticker,
                "name": position.name,
                "asset_class": position.asset_class,
                "factor": factor,
                "weight": position.allocation_pct,
                "sensitivity": sensitivity,
                "price_move_pct": price_move,
                "fx_move_pct": fx_move,
                "total_move_pct": total_move,
                "pnl": pnl,
            }
        )

    rows.sort(key=lambda row: row["pnl"])
    pct = total_pnl / total_value if total_value else 0.0

    def ordered(buckets: dict[str, float]) -> list[dict[str, Any]]:
        items = sorted(buckets.items(), key=lambda item: item[1])
        return [
            {"key": key, "pnl": round_money(value), "pct_of_portfolio": round_ratio(value / total_value if total_value else 0.0)}
            for key, value in items
        ]

    return {
        "value_before": round_money(total_value),
        "value_after": round_money(total_value + total_pnl),
        "pnl": round_money(total_pnl),
        "pnl_pct": round_ratio(pct),
        "fx_pnl": round_money(fx_pnl_total),
        "by_factor": ordered(by_factor),
        "by_asset_class": ordered(by_asset_class),
        "positions": [
            {
                "ticker": row["ticker"],
                "name": row["name"],
                "asset_class": row["asset_class"],
                "factor": row["factor"],
                "weight": round_ratio(row["weight"]),
                "sensitivity": round_ratio(row["sensitivity"]),
                "price_move_pct": round_ratio(row["price_move_pct"]),
                "fx_move_pct": round_ratio(row["fx_move_pct"]),
                "total_move_pct": round_ratio(row["total_move_pct"]),
                "pnl": round_money(row["pnl"]),
            }
            for row in rows
        ],
    }


def stress_report(
    analytics: Any,
    scenario_keys: list[str] | None = None,
    custom: Shock | None = None,
    durations: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Run preset and/or custom scenarios against the loaded portfolio."""
    keys = scenario_keys if scenario_keys is not None else ([] if custom else [s.key for s in SCENARIOS])
    unknown = [key for key in keys if key not in SCENARIO_INDEX]
    if unknown:
        raise ValueError(f"unknown scenario {unknown[0]!r}")

    positions = analytics.positions
    betas = holding_betas(analytics.market.prices_native, analytics.market.benchmark)
    base = analytics.portfolio.base_currency

    results: list[dict[str, Any]] = []
    for key in keys:
        scenario = SCENARIO_INDEX[key]
        outcome = stress_positions(positions, betas, base, scenario.shock, durations)
        results.append(
            {
                "key": scenario.key,
                "name": scenario.name,
                "description": scenario.description,
                "window": scenario.window,
                "kind": scenario.kind,
                "shock": _shock_payload(scenario.shock),
                **outcome,
            }
        )
    if custom is not None:
        outcome = stress_positions(positions, betas, base, custom, durations)
        results.append(
            {
                "key": "custom",
                "name": "Custom scenario",
                "description": "User-defined simultaneous shocks.",
                "window": "Instant shock",
                "kind": "custom",
                "shock": _shock_payload(custom),
                **outcome,
            }
        )

    return json_safe(
        {
            "as_of": analytics.as_of,
            "base_currency": base,
            "total_value": round_money(analytics.total_value),
            "benchmark": analytics.settings.benchmark_name,
            "results": results,
            "betas": {ticker: round_ratio(beta) for ticker, beta in betas.items()},
            "methodology": (
                "First-order factor model. Each position has one primary factor "
                "(equity beta, bond duration, gold, crypto) plus a currency effect. "
                "No convexity, sector or credit factors. Historical scenarios apply "
                "stylised factor moves, not the holdings' own price history."
            ),
        }
    )


def _shock_payload(shock: Shock) -> dict[str, float]:
    return {
        "equity_pct": round_ratio(shock.equity_pct),
        "rates_bps": round_ratio(shock.rates_bps),
        "usd_pct": round_ratio(shock.usd_pct),
        "gold_pct": round_ratio(shock.gold_pct),
        "crypto_pct": round_ratio(shock.resolved_crypto_pct),
    }


# --------------------------------------------------------------------------
# Attribution: Brinson-Fachler
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Segment:
    """One bucket of the book and of the benchmark. Fractions throughout."""

    key: str
    wp: float  # portfolio weight at the start of the window
    wb: float  # benchmark weight
    rp: float  # portfolio return of the bucket over the window
    rb: float  # benchmark return of the bucket over the window


def brinson_fachler(segments: list[Segment]) -> dict[str, Any]:
    """Allocation, selection and interaction effects per segment.

    Both weight vectors are expected to sum to one. They are normalised if
    they do not (the amount is reported), because an identity that only holds
    for well-formed input should not silently break on sloppy input.
    """
    if not segments:
        return {"segments": [], "totals": _empty_totals()}

    sum_wp = sum(s.wp for s in segments)
    sum_wb = sum(s.wb for s in segments)
    if sum_wp <= 0 or sum_wb <= 0:
        raise ValueError("portfolio and benchmark weights must each sum to a positive number")

    norm = [
        Segment(s.key, s.wp / sum_wp, s.wb / sum_wb, s.rp, s.rb) for s in segments
    ]
    benchmark_return = sum(s.wb * s.rb for s in norm)
    portfolio_return = sum(s.wp * s.rp for s in norm)

    rows = []
    allocation = selection = interaction = 0.0
    for s in norm:
        a = (s.wp - s.wb) * (s.rb - benchmark_return)
        sel = s.wb * (s.rp - s.rb)
        inter = (s.wp - s.wb) * (s.rp - s.rb)
        allocation += a
        selection += sel
        interaction += inter
        rows.append(
            {
                "key": s.key,
                "portfolio_weight": round_ratio(s.wp),
                "benchmark_weight": round_ratio(s.wb),
                "portfolio_return_pct": round_ratio(s.rp),
                "benchmark_return_pct": round_ratio(s.rb),
                "allocation_pct": round_ratio(a),
                "selection_pct": round_ratio(sel),
                "interaction_pct": round_ratio(inter),
                "total_pct": round_ratio(a + sel + inter),
            }
        )
    rows.sort(key=lambda row: abs(float(row["total_pct"])), reverse=True)

    active = portfolio_return - benchmark_return
    return {
        "segments": rows,
        "totals": {
            "portfolio_return_pct": round_ratio(portfolio_return),
            "benchmark_return_pct": round_ratio(benchmark_return),
            "active_return_pct": round_ratio(active),
            "allocation_pct": round_ratio(allocation),
            "selection_pct": round_ratio(selection),
            "interaction_pct": round_ratio(interaction),
            # The three effects must add up to the active return. Anything left
            # is rounding, so a visible value here would mean a bug.
            "residual_pct": round_ratio(active - (allocation + selection + interaction)),
            "weights_normalised": bool(abs(sum_wp - 1.0) > 1e-6 or abs(sum_wb - 1.0) > 1e-6),
        },
    }


def _empty_totals() -> dict[str, Any]:
    return {
        "portfolio_return_pct": 0.0,
        "benchmark_return_pct": 0.0,
        "active_return_pct": 0.0,
        "allocation_pct": 0.0,
        "selection_pct": 0.0,
        "interaction_pct": 0.0,
        "residual_pct": 0.0,
        "weights_normalised": False,
    }


@dataclass(frozen=True)
class BenchmarkSegment:
    """A user-defined benchmark bucket. Give either a return or a proxy ticker."""

    key: str
    weight: float
    return_pct: float | None = None
    proxy: str | None = None


ProxyLoader = Callable[[str, pd.Timestamp, pd.Timestamp], float]
"""Resolve ``(ticker, start, end)`` to the proxy's total price return."""


def _window(analytics: Any, period: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    index = analytics.market.prices_base.index
    start = metrics._window_start_stamp(index, period)  # noqa: SLF001 - shared window rule
    return start, index[-1]


def attribution_report(
    analytics: Any,
    period: str = "all",
    group_by: str = "asset_class",
    benchmark: list[BenchmarkSegment] | None = None,
    proxy_loader: ProxyLoader | None = None,
) -> dict[str, Any]:
    """Brinson-Fachler attribution of the book against a segment benchmark.

    Without ``benchmark`` the **equal-weight** opportunity set is used: every
    segment the book holds gets the same benchmark weight, and a segment's
    benchmark return is the simple average of its holdings. It needs no
    outside data and answers a real question - did concentrating in some
    segments, and sizing some holdings above others, add value compared with
    spreading evenly? With ``benchmark`` the caller supplies the policy
    weights and either each bucket's return or a proxy ticker to price.
    """
    if group_by not in ("asset_class", "region", "currency"):
        raise ValueError("group_by must be one of asset_class, region, currency")
    if period not in ("day", "week", "month", "ytd", "all"):
        raise ValueError("period must be one of day, week, month, ytd, all")

    start, end = _window(analytics, period)
    prices = analytics.market.prices_base
    holdings = {h.ticker: h for h in analytics.portfolio.holdings}
    qty_frame = analytics.quantity_frame

    def segment_of(ticker: str) -> str:
        holding = holdings[ticker]
        if group_by == "asset_class":
            return holding.asset_class or "Unclassified"
        if group_by == "region":
            return holding.region_label or "Unclassified"
        return normalise_currency(holding.currency)[0]

    start_values: dict[str, float] = {}
    returns: dict[str, float] = {}
    excluded: list[str] = []
    for ticker in analytics.portfolio.tickers:
        quantity = float(qty_frame[ticker].loc[start]) if start in qty_frame.index else 0.0
        p0 = float(prices[ticker].loc[start])
        p1 = float(prices[ticker].loc[end])
        if quantity <= 0.0 or not np.isfinite(p0) or not np.isfinite(p1) or p0 <= 0.0:
            excluded.append(ticker)
            continue
        start_values[ticker] = quantity * p0
        returns[ticker] = p1 / p0 - 1.0

    if not start_values:
        raise ValueError("no position was held at the start of the window")

    total_start = sum(start_values.values())
    seg_value: dict[str, float] = {}
    seg_weighted: dict[str, float] = {}
    seg_simple: dict[str, list[float]] = {}
    for ticker, value in start_values.items():
        key = segment_of(ticker)
        seg_value[key] = seg_value.get(key, 0.0) + value
        seg_weighted[key] = seg_weighted.get(key, 0.0) + value * returns[ticker]
        seg_simple.setdefault(key, []).append(returns[ticker])

    portfolio_weight = {key: value / total_start for key, value in seg_value.items()}
    portfolio_return = {key: seg_weighted[key] / seg_value[key] for key in seg_value}

    if benchmark:
        bench_weight: dict[str, float] = {}
        bench_return: dict[str, float] = {}
        for item in benchmark:
            if item.weight < 0:
                raise ValueError(f"benchmark weight for {item.key!r} is negative")
            if item.return_pct is not None:
                value = float(item.return_pct)
            elif item.proxy:
                if proxy_loader is None:
                    raise ValueError(f"no data source available to price proxy {item.proxy!r}")
                value = float(proxy_loader(item.proxy, start, end))
            else:
                raise ValueError(f"benchmark segment {item.key!r} needs a return_pct or a proxy")
            bench_weight[item.key] = bench_weight.get(item.key, 0.0) + float(item.weight)
            bench_return[item.key] = value
        mode = "custom"
        label = "Custom policy benchmark"
    else:
        count = len(seg_value)
        bench_weight = {key: 1.0 / count for key in seg_value}
        bench_return = {key: float(np.mean(seg_simple[key])) for key in seg_value}
        mode = "equal_weight"
        label = "Equal-weight opportunity set"

    keys = list(dict.fromkeys([*seg_value.keys(), *bench_weight.keys()]))
    segments = [
        Segment(
            key,
            portfolio_weight.get(key, 0.0),
            bench_weight.get(key, 0.0),
            portfolio_return.get(key, bench_return.get(key, 0.0)),
            bench_return.get(key, portfolio_return.get(key, 0.0)),
        )
        for key in keys
    ]
    result = brinson_fachler(segments)

    # Where the book holds nothing, its "return" is set to the benchmark's, so
    # an empty bucket contributes allocation only and never a phantom selection.
    book_twr = float((1.0 + analytics.portfolio_returns).prod() - 1.0)
    return json_safe(
        {
            "as_of": analytics.as_of,
            "period": period,
            "group_by": group_by,
            "start_date": start.strftime("%Y-%m-%d"),
            "end_date": end.strftime("%Y-%m-%d"),
            "benchmark_mode": mode,
            "benchmark_label": label,
            "excluded": excluded,
            "time_weighted_return_pct": round_ratio(book_twr),
            "basis": (
                "Single-period buy-and-hold from the window start, using the "
                "positions held on that date. The book's time-weighted return is "
                "shown for reference and can differ."
            ),
            **result,
        }
    )


# --------------------------------------------------------------------------
# X-Ray
# --------------------------------------------------------------------------

LARGEST_HIGH: float = 0.25
LARGEST_MEDIUM: float = 0.15
CLASS_HIGH: float = 0.70
REGION_HIGH: float = 0.60
OVERLAP_CORRELATION: float = 0.80
RISK_HOG_RATIO: float = 1.5
RISK_HOG_MIN_SHARE: float = 0.10


def _exposure(positions: list[Any], attribute: str) -> list[dict[str, Any]]:
    buckets: dict[str, float] = {}
    for position in positions:
        key = getattr(position, attribute) or "Unclassified"
        if attribute == "currency":
            key = normalise_currency(key)[0]
        buckets[key] = buckets.get(key, 0.0) + float(position.allocation_pct)
    rows = [{"key": key, "weight": round_ratio(value)} for key, value in buckets.items()]
    rows.sort(key=lambda row: float(row["weight"]), reverse=True)
    return rows


def _clusters(tickers: list[str], matrix: np.ndarray, threshold: float) -> list[list[str]]:
    """Connected components of the 'highly correlated' graph, size >= 2."""
    parent = list(range(len(tickers)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(tickers)):
        for j in range(i + 1, len(tickers)):
            if matrix[i, j] >= threshold:
                parent[find(i)] = find(j)

    groups: dict[int, list[str]] = {}
    for i, ticker in enumerate(tickers):
        groups.setdefault(find(i), []).append(ticker)
    return [group for group in groups.values() if len(group) >= 2]


def xray_report(analytics: Any) -> dict[str, Any]:
    """One-screen diagnosis: concentration, exposures, risk vs weight, overlap."""
    positions = list(analytics.positions)
    weights = pd.Series({p.ticker: float(p.value_base) for p in positions}, dtype=float)
    total = float(weights.sum())
    findings: list[dict[str, str]] = []

    concentration = metrics.concentration(weights)
    by_class = _exposure(positions, "asset_class")
    by_region = _exposure(positions, "region")
    by_currency = _exposure(positions, "currency")

    largest = max(positions, key=lambda p: p.allocation_pct)
    if largest.allocation_pct >= LARGEST_HIGH:
        findings.append(
            {
                "severity": "high",
                "code": "single_position",
                "message": f"{largest.ticker} is {largest.allocation_pct:.0%} of the portfolio.",
            }
        )
    elif largest.allocation_pct >= LARGEST_MEDIUM:
        findings.append(
            {
                "severity": "medium",
                "code": "single_position",
                "message": f"{largest.ticker} is {largest.allocation_pct:.0%} of the portfolio.",
            }
        )
    if by_class and float(by_class[0]["weight"]) >= CLASS_HIGH:
        findings.append(
            {
                "severity": "high",
                "code": "asset_class",
                "message": f"{float(by_class[0]['weight']):.0%} of the portfolio is {by_class[0]['key']}.",
            }
        )
    if by_region and float(by_region[0]["weight"]) >= REGION_HIGH:
        findings.append(
            {
                "severity": "medium",
                "code": "region",
                "message": f"{float(by_region[0]['weight']):.0%} of the portfolio is in {by_region[0]['key']}.",
            }
        )
    base = analytics.portfolio.base_currency
    foreign = sum(float(r["weight"]) for r in by_currency if r["key"] != base)
    if foreign >= 0.5:
        findings.append(
            {
                "severity": "medium",
                "code": "currency",
                "message": f"{foreign:.0%} of the portfolio is priced in a currency other than {base}.",
            }
        )

    # Risk versus capital
    contributions = metrics.risk_contributions(analytics.asset_returns, weights)
    risk_rows: list[dict[str, Any]] = []
    for ticker, row in contributions.iterrows():
        weight = float(row["weight"])
        share = float(row["contribution_pct"])
        ratio = share / weight if weight > 0 else 0.0
        risk_rows.append(
            {
                "ticker": ticker,
                "weight": round_ratio(weight),
                "risk_share": round_ratio(share),
                "risk_to_weight": round_ratio(ratio),
            }
        )
        if ratio >= RISK_HOG_RATIO and share >= RISK_HOG_MIN_SHARE:
            findings.append(
                {
                    "severity": "high" if share >= 0.4 else "medium",
                    "code": "risk_hog",
                    "message": (
                        f"{ticker} is {weight:.0%} of capital but {share:.0%} of portfolio volatility."
                    ),
                }
            )
    risk_rows.sort(key=lambda row: float(row["risk_share"]), reverse=True)

    # Statistical overlap
    correlation = metrics.correlation_matrix(analytics.asset_returns)
    tickers = [t for t in correlation.columns if t in weights.index]
    matrix = correlation.reindex(index=tickers, columns=tickers).to_numpy(dtype=float)
    matrix = np.nan_to_num(matrix, nan=0.0)
    pairs = []
    for i in range(len(tickers)):
        for j in range(i + 1, len(tickers)):
            if matrix[i, j] >= OVERLAP_CORRELATION:
                pairs.append(
                    {"a": tickers[i], "b": tickers[j], "correlation": round_ratio(matrix[i, j])}
                )
    pairs.sort(key=lambda row: float(row["correlation"]), reverse=True)
    clusters = []
    for group in _clusters(tickers, matrix, OVERLAP_CORRELATION):
        combined = float(weights.reindex(group).sum() / total) if total else 0.0
        clusters.append({"tickers": group, "combined_weight": round_ratio(combined)})
        findings.append(
            {
                "severity": "high" if combined >= 0.4 else "medium",
                "code": "overlap",
                "message": (
                    f"{', '.join(group)} move together (correlation >= {OVERLAP_CORRELATION:.2f}) "
                    f"and are {combined:.0%} of the portfolio combined."
                ),
            }
        )
    clusters.sort(key=lambda row: float(row["combined_weight"]), reverse=True)

    # Diversification ratio: weighted-average vol over portfolio vol (>= 1)
    diversification: float | None = None
    aligned = analytics.asset_returns[tickers].dropna(how="any") if tickers else pd.DataFrame()
    if len(aligned) > 2 and total > 0:
        w = (weights.reindex(tickers) / total).to_numpy(dtype=float)
        vols = aligned.std(ddof=1).to_numpy(dtype=float)
        cov = np.atleast_2d(np.cov(aligned.to_numpy(dtype=float), rowvar=False, ddof=1))
        port_vol = float(np.sqrt(w @ cov @ w))
        if port_vol > 0:
            diversification = float((w * vols).sum() / port_vol)

    rank = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: rank.get(f["severity"], 3))
    if not findings:
        findings.append(
            {
                "severity": "low",
                "code": "none",
                "message": "No concentration, overlap or risk-versus-capital flags at the current thresholds.",
            }
        )

    return json_safe(
        {
            "as_of": analytics.as_of,
            "total_value": round_money(total),
            "positions": len(positions),
            "headline": {
                "effective_holdings": round_ratio(concentration.effective_holdings),
                "herfindahl": round_ratio(concentration.herfindahl),
                "largest_pct": round_ratio(concentration.largest),
                "top_five_pct": round_ratio(concentration.top_five),
                "diversification_ratio": round_ratio(diversification),
            },
            "findings": findings,
            "exposure": {
                "asset_class": by_class,
                "region": by_region,
                "currency": by_currency,
            },
            "risk_vs_capital": risk_rows,
            "overlap": {"pairs": pairs, "clusters": clusters, "threshold": OVERLAP_CORRELATION},
            "methodology": (
                "Overlap is statistical, inferred from daily return correlation. "
                "It does not look through ETF or fund holdings."
            ),
        }
    )
