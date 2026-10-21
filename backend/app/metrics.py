"""Portfolio risk and performance metrics.

Every public function is pure: it takes pandas/numpy inputs and returns plain
Python or numpy values, with the formula it implements stated in its docstring.
No I/O, no configuration lookups, no rounding — presentation concerns live in
``portfolio.py`` and ``serialize.py``.

Conventions
-----------
* *Returns* are simple (arithmetic) daily returns, ``p_t / p_{t-1} - 1``.
* *Annualisation* uses ``TRADING_DAYS = 252`` unless a caller overrides it.
* *VaR* is returned as a **positive fraction of portfolio value** representing
  the loss threshold, e.g. ``0.0212`` means "a 1-day loss of 2.12% or worse is
  expected on 5% of days" at 95% confidence.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from statistics import NormalDist
from typing import Literal, Sequence

import numpy as np
import pandas as pd

TRADING_DAYS: int = 252

PeriodKey = Literal["day", "week", "month", "ytd", "all"]


# --------------------------------------------------------------------------
# Returns
# --------------------------------------------------------------------------


def daily_returns(prices: pd.Series) -> pd.Series:
    """Simple daily returns.

    Formula: ``r_t = p_t / p_{t-1} - 1``

    The first observation has no predecessor and is dropped.
    """
    return prices.astype(float).pct_change().dropna()


def daily_returns_frame(prices: pd.DataFrame) -> pd.DataFrame:
    """Column-wise simple daily returns; rows with any missing value dropped.

    Formula: ``r_{t,i} = p_{t,i} / p_{t-1,i} - 1``
    """
    return prices.astype(float).pct_change().dropna(how="any")


# --------------------------------------------------------------------------
# Dispersion and risk-adjusted return
# --------------------------------------------------------------------------


def annualized_volatility(returns: pd.Series, trading_days: int = TRADING_DAYS) -> float:
    """Annualised standard deviation of daily returns.

    Formula: ``sigma_annual = std(r) * sqrt(trading_days)``

    Uses the sample standard deviation (``ddof=1``).
    """
    if len(returns) < 2:
        return float("nan")
    return float(returns.std(ddof=1) * np.sqrt(trading_days))


def sharpe_ratio(
    returns: pd.Series,
    daily_risk_free_rate: float,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised Sharpe ratio.

    Formula: ``((mean(r) - rf_daily) / std(r)) * sqrt(trading_days)``

    Args:
        returns: Daily simple returns.
        daily_risk_free_rate: Risk-free rate per trading day.
        trading_days: Annualisation factor.

    Returns:
        The annualised Sharpe ratio, or NaN if volatility is zero.
    """
    if len(returns) < 2:
        return float("nan")
    std = float(returns.std(ddof=1))
    if std == 0.0:
        return float("nan")
    excess = float(returns.mean()) - daily_risk_free_rate
    return float(excess / std * np.sqrt(trading_days))


def downside_deviation(
    returns: pd.Series,
    daily_risk_free_rate: float,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised downside deviation (the Sortino denominator).

    Formula: ``sqrt(mean(min(r - rf_daily, 0)^2)) * sqrt(trading_days)``

    Shortfalls are squared against the full sample length (not just the losing
    days), which is the standard definition — averaging over losing days only
    would penalise portfolios that rarely lose.
    """
    if len(returns) < 2:
        return float("nan")
    shortfall = np.minimum(returns.to_numpy(dtype=float) - daily_risk_free_rate, 0.0)
    return float(np.sqrt(np.mean(shortfall**2)) * np.sqrt(trading_days))


def sortino_ratio(
    returns: pd.Series,
    daily_risk_free_rate: float,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised Sortino ratio: excess return per unit of *downside* risk.

    Formula: ``(mean(r) - rf_daily) * trading_days / downside_deviation``

    Returns NaN when there is no downside deviation (no losing days).
    """
    if len(returns) < 2:
        return float("nan")
    dd = downside_deviation(returns, daily_risk_free_rate, trading_days)
    if not np.isfinite(dd) or dd == 0.0:
        return float("nan")
    annual_excess = (float(returns.mean()) - daily_risk_free_rate) * trading_days
    return float(annual_excess / dd)


# --------------------------------------------------------------------------
# Drawdown
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Drawdown:
    """Result of a maximum-drawdown search.

    Attributes:
        max_drawdown: Worst peak-to-trough decline as a negative fraction
            (``-0.243`` == a 24.3% fall).
        peak_date: Date of the running maximum preceding the trough.
        trough_date: Date of the trough.
        peak_value: Portfolio value at the peak.
        trough_value: Portfolio value at the trough.
        recovery_date: First date the portfolio regained the peak, or ``None``
            if it has not yet recovered.
    """

    max_drawdown: float
    peak_date: date | None
    trough_date: date | None
    peak_value: float
    trough_value: float
    recovery_date: date | None


def max_drawdown(equity: pd.Series) -> Drawdown:
    """Largest peak-to-trough decline of an equity curve.

    Formula: ``min_t ( v_t / max_{s<=t} v_s - 1 )``
    """
    values = equity.astype(float)
    if values.empty:
        return Drawdown(float("nan"), None, None, float("nan"), float("nan"), None)

    running_peak = values.cummax()
    drawdown_series = values / running_peak - 1.0

    trough_stamp = drawdown_series.idxmin()
    trough_value = float(values.loc[trough_stamp])
    peak_stamp = values.loc[:trough_stamp].idxmax()
    peak_value = float(values.loc[peak_stamp])

    after_trough = values.loc[trough_stamp:]
    recovered = after_trough[after_trough >= peak_value]
    recovery_stamp = recovered.index[0] if not recovered.empty else None

    return Drawdown(
        max_drawdown=float(drawdown_series.min()),
        peak_date=pd.Timestamp(peak_stamp).date(),
        trough_date=pd.Timestamp(trough_stamp).date(),
        peak_value=peak_value,
        trough_value=trough_value,
        recovery_date=pd.Timestamp(recovery_stamp).date() if recovery_stamp is not None else None,
    )


def drawdown_series(equity: pd.Series) -> pd.Series:
    """Drawdown at every point in time, as a negative fraction.

    Formula: ``d_t = v_t / max_{s<=t} v_s - 1``
    """
    values = equity.astype(float)
    return values / values.cummax() - 1.0


# --------------------------------------------------------------------------
# Value at Risk
# --------------------------------------------------------------------------


def historical_var(returns: pd.Series, confidence: float = 0.95) -> float:
    """1-day historical (non-parametric) Value at Risk.

    Formula: ``VaR = -quantile(r, 1 - confidence)``

    Reads the empirical loss threshold straight off the return distribution,
    making no assumption about its shape.

    Returns:
        A positive fraction of portfolio value. ``0.0` if the quantile is
        positive (i.e. even the tail was a gain over the sample).
    """
    if returns.empty:
        return float("nan")
    quantile = float(np.quantile(returns.to_numpy(dtype=float), 1.0 - confidence))
    return float(max(-quantile, 0.0))


def parametric_var(returns: pd.Series, confidence: float = 0.95) -> float:
    """1-day parametric (variance-covariance) Value at Risk.

    Formula: ``VaR = -(mu + z * sigma)`` where ``z = Phi^-1(1 - confidence)``

    Assumes returns are normally distributed, which understates tail risk for
    assets with fat tails — shown alongside the historical figure so the two
    can be compared.

    Returns:
        A positive fraction of portfolio value.
    """
    if len(returns) < 2:
        return float("nan")
    mu = float(returns.mean())
    sigma = float(returns.std(ddof=1))
    z = NormalDist().inv_cdf(1.0 - confidence)
    return float(max(-(mu + z * sigma), 0.0))


# --------------------------------------------------------------------------
# Benchmark relationship
# --------------------------------------------------------------------------


def beta(portfolio_returns: pd.Series, benchmark_returns: pd.Series) -> float:
    """Sensitivity of the portfolio to the benchmark.

    Formula: ``beta = cov(r_p, r_b) / var(r_b)``

    Both series are inner-joined on date first, so only overlapping trading
    days contribute.
    """
    joined = pd.concat([portfolio_returns, benchmark_returns], axis=1, join="inner").dropna()
    if len(joined) < 2:
        return float("nan")
    port = joined.iloc[:, 0].to_numpy(dtype=float)
    bench = joined.iloc[:, 1].to_numpy(dtype=float)
    variance = float(np.var(bench, ddof=1))
    if variance == 0.0:
        return float("nan")
    covariance = float(np.cov(port, bench, ddof=1)[0, 1])
    return float(covariance / variance)


def correlation(portfolio_returns: pd.Series, benchmark_returns: pd.Series) -> float:
    """Pearson correlation of two return series."""
    aligned = pd.concat(
        [portfolio_returns.rename("portfolio"), benchmark_returns.rename("benchmark")], axis=1
    ).dropna()
    if len(aligned) < 2:
        return float("nan")
    return float(aligned["portfolio"].corr(aligned["benchmark"]))


def correlation_matrix(returns: pd.DataFrame) -> pd.DataFrame:
    """Pearson correlation matrix of daily returns.

    Formula: ``rho_ij = cov(r_i, r_j) / (sigma_i * sigma_j)``
    """
    return returns.corr(method="pearson")


# --------------------------------------------------------------------------
# Period performance
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PeriodChange:
    """Absolute and relative change of an equity curve over a window.

    Attributes:
        period: Window identifier (``day``/``week``/``month``/``ytd``/``all``).
        start_date: Date of the opening observation used.
        start_value: Opening market value.
        end_value: Closing market value.
        absolute: Investment gain over the window, in base currency. External
            contributions are excluded, so a deposit does not look like a gain.
        percent: Time-weighted return over the window, as a fraction.
        flows: Contributions that entered the portfolio inside the window.
    """

    period: PeriodKey
    start_date: date
    start_value: float
    end_value: float
    absolute: float
    percent: float
    flows: float = 0.0


def _window_start_stamp(index: pd.DatetimeIndex, period: PeriodKey) -> pd.Timestamp:
    """Resolve the opening observation for a named window.

    ``day`` steps back one trading day; ``week``/``month`` step back one
    calendar week/month and snap to the last trading day at or before that
    date; ``ytd`` uses the final close of the previous year; ``all`` uses the
    first observation available.
    """
    last = index[-1]

    if period == "all":
        return index[0]
    if period == "day":
        return index[-2] if len(index) >= 2 else index[0]

    if period == "week":
        target = last - pd.Timedelta(days=7)
    elif period == "month":
        target = last - pd.DateOffset(months=1)
    elif period == "ytd":
        target = pd.Timestamp(year=last.year, month=1, day=1) - pd.Timedelta(days=1)
    else:  # pragma: no cover - guarded by the Literal type
        raise ValueError(f"unknown period {period!r}")

    earlier = index[index <= target]
    return earlier[-1] if len(earlier) else index[0]


def period_change(
    equity: pd.Series,
    period: PeriodKey,
    *,
    returns: pd.Series | None = None,
    flows: pd.Series | None = None,
) -> PeriodChange:
    """Change in an equity curve over a named window.

    With only ``equity`` the formulas are ``absolute = v_end - v_start`` and
    ``percent = v_end / v_start - 1``. When ``returns`` and ``flows`` are
    supplied the result is contribution-aware: ``absolute`` removes external
    cash flows and ``percent`` chains the time-weighted daily returns, so a
    deposit is not reported as investment performance.
    """
    index = pd.DatetimeIndex(equity.index)
    start_stamp = _window_start_stamp(index, period)
    start_value = float(equity.loc[start_stamp])
    end_value = float(equity.iloc[-1])

    if returns is None or flows is None:
        percent = (end_value / start_value - 1.0) if start_value else float("nan")
        return PeriodChange(
            period=period,
            start_date=pd.Timestamp(start_stamp).date(),
            start_value=start_value,
            end_value=end_value,
            absolute=end_value - start_value,
            percent=percent,
        )

    window = index[(index >= start_stamp) & (index <= index[-1])]
    # The opening observation is the baseline; its own return belongs to the
    # previous period, so the chain starts strictly after it.
    held = index[index > start_stamp]
    window_returns = returns.reindex(held).dropna()
    if len(window_returns):
        percent = float((1.0 + window_returns).prod() - 1.0)
    else:
        percent = 0.0
    flow_sum = float(flows.reindex(window).fillna(0.0).sum())
    # Flows on the opening date are already inside start_value.
    if len(window):
        flow_sum -= float(flows.reindex([window[0]]).fillna(0.0).iloc[0])

    return PeriodChange(
        period=period,
        start_date=pd.Timestamp(start_stamp).date(),
        start_value=start_value,
        end_value=end_value,
        absolute=end_value - start_value - flow_sum,
        percent=percent,
        flows=flow_sum,
    )


# --------------------------------------------------------------------------
# Position-level arithmetic
# --------------------------------------------------------------------------


def position_values(prices_base: pd.DataFrame, quantities: pd.Series) -> pd.DataFrame:
    """Per-holding market value through time, in base currency.

    Formula: ``value_{t,i} = quantity_i * price_{t,i}``
    """
    return prices_base.mul(quantities.reindex(prices_base.columns), axis=1)


def equity_curve(position_value_frame: pd.DataFrame) -> pd.Series:
    """Total portfolio value through time.

    Formula: ``V_t = sum_i quantity_i * price_{t,i}``
    """
    return position_value_frame.sum(axis=1)


def allocation(values: pd.Series) -> pd.Series:
    """Share of total value per entry, as a fraction summing to 1.

    Formula: ``w_i = v_i / sum_j v_j``
    """
    total = float(values.sum())
    if total == 0.0:
        return values * 0.0
    return values / total


def unrealized_pnl(
    quantity: float,
    price_base: float,
    cost_basis_per_unit_base: float,
) -> tuple[float, float]:
    """Unrealised profit and loss for one position, in base currency.

    Formulas:
        ``pnl_abs = quantity * (price - cost_basis)``
        ``pnl_pct = price / cost_basis - 1``

    Args:
        quantity: Units held.
        price_base: Current price converted to base currency.
        cost_basis_per_unit_base: Entry price converted to base currency at the
            FX rate of the acquisition date.

    Returns:
        ``(absolute_pnl, percent_pnl)``; percent is NaN for a zero cost basis.
    """
    absolute = quantity * (price_base - cost_basis_per_unit_base)
    percent = (price_base / cost_basis_per_unit_base - 1.0) if cost_basis_per_unit_base else float("nan")
    return float(absolute), float(percent)

# --------------------------------------------------------------------------
# Contribution-aware performance
# --------------------------------------------------------------------------

def annualized_return(returns: pd.Series, trading_days: int = TRADING_DAYS) -> float:
    """Geometric annualised return from daily simple returns.

    Formula: ``(prod(1 + r)) ** (trading_days / n) - 1``

    Unlike the arithmetic mean, this compounds the observed path, so it matches
    the growth an investor actually experienced. Returns NaN for an empty
    sample or a path that lost more than 100%.
    """
    clean = returns.dropna()
    if clean.empty:
        return float("nan")
    growth = float((1.0 + clean).prod())
    if growth <= 0.0:
        return float("nan")
    return float(growth ** (trading_days / len(clean)) - 1.0)


def calmar_ratio(
    returns: pd.Series,
    equity: pd.Series,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised return divided by the absolute maximum drawdown.

    Formula: ``annualized_return / |max_drawdown|``
    """
    annual = annualized_return(returns, trading_days)
    worst = max_drawdown(equity).max_drawdown
    if not np.isfinite(annual) or not np.isfinite(worst) or worst == 0.0:
        return float("nan")
    return float(annual / abs(worst))


def historical_cvar(returns: pd.Series, confidence: float = 0.95) -> float:
    """1-day historical Expected Shortfall (CVaR).

    Formula: ``-(1 / n_tail) * sum(r | r <= quantile(r, 1 - confidence))``

    The average loss on the days that breached VaR. Unlike VaR it describes the
    severity of the tail rather than its threshold, and it is always at least
    as large as the historical VaR computed at the same confidence.

    Returns:
        A positive fraction of portfolio value, or NaN for an empty sample.
    """
    clean = returns.dropna()
    if clean.empty:
        return float("nan")
    threshold = float(np.quantile(clean.to_numpy(dtype=float), 1.0 - confidence))
    tail = clean[clean <= threshold]
    if tail.empty:
        return float("nan")
    return float(max(-float(tail.mean()), 0.0))


def rolling_volatility(
    returns: pd.Series,
    window: int = 63,
    trading_days: int = TRADING_DAYS,
) -> pd.Series:
    """Annualised rolling volatility over ``window`` daily observations."""
    if window < 2:
        raise ValueError("window must be at least 2")
    return returns.rolling(window).std(ddof=1) * float(np.sqrt(trading_days))


def tracking_error(
    portfolio_returns: pd.Series,
    benchmark_returns: pd.Series,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised standard deviation of active returns.

    Formula: ``std(r_p - r_b, ddof=1) * sqrt(trading_days)``
    """
    active = _active_returns(portfolio_returns, benchmark_returns)
    if len(active) < 2:
        return float("nan")
    return float(active.std(ddof=1) * np.sqrt(trading_days))


def information_ratio(
    portfolio_returns: pd.Series,
    benchmark_returns: pd.Series,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised active return per unit of tracking error.

    Formula: ``mean(r_p - r_b) / std(r_p - r_b) * sqrt(trading_days)``
    """
    active = _active_returns(portfolio_returns, benchmark_returns)
    if len(active) < 2:
        return float("nan")
    deviation = float(active.std(ddof=1))
    if deviation == 0.0:
        return float("nan")
    return float(active.mean() / deviation * np.sqrt(trading_days))


def jensen_alpha(
    portfolio_returns: pd.Series,
    benchmark_returns: pd.Series,
    daily_risk_free_rate: float,
    trading_days: int = TRADING_DAYS,
) -> float:
    """Annualised Jensen's alpha against the benchmark.

    Formula: ``(mean(r_p) - rf_d - beta * (mean(r_b) - rf_d)) * trading_days``

    The intercept of the CAPM regression, expressed as an annual simple return.
    """
    joined = pd.concat([portfolio_returns, benchmark_returns], axis=1, join="inner").dropna()
    if len(joined) < 2:
        return float("nan")
    port = joined.iloc[:, 0]
    bench = joined.iloc[:, 1]
    sensitivity = beta(port, bench)
    if not np.isfinite(sensitivity):
        return float("nan")
    alpha_daily = (float(port.mean()) - daily_risk_free_rate) - sensitivity * (
        float(bench.mean()) - daily_risk_free_rate
    )
    return float(alpha_daily * trading_days)


def up_down_capture(
    portfolio_returns: pd.Series,
    benchmark_returns: pd.Series,
) -> tuple[float, float]:
    """Up- and down-market capture ratios.

    ``up = mean(r_p | r_b > 0) / mean(r_b | r_b > 0)`` and the same for the
    negative benchmark days. ``1.0`` means the portfolio moved one-for-one with
    the benchmark; below 1 is defensive, above 1 is aggressive. Both are
    returned as ratios (``1.05`` == 105%), or NaN when there are no such days.
    """
    joined = pd.concat([portfolio_returns, benchmark_returns], axis=1, join="inner").dropna()
    if joined.empty:
        return float("nan"), float("nan")
    port = joined.iloc[:, 0]
    bench = joined.iloc[:, 1]

    up = bench > 0.0
    down = bench < 0.0
    up_ratio = float("nan")
    down_ratio = float("nan")
    if up.any():
        denominator = float(bench[up].mean())
        if denominator:
            up_ratio = float(port[up].mean() / denominator)
    if down.any():
        denominator = float(bench[down].mean())
        if denominator:
            down_ratio = float(port[down].mean() / denominator)
    return up_ratio, down_ratio


def _active_returns(
    portfolio_returns: pd.Series, benchmark_returns: pd.Series
) -> pd.Series:
    joined = pd.concat([portfolio_returns, benchmark_returns], axis=1, join="inner").dropna()
    if joined.empty:
        return pd.Series(dtype=float)
    return joined.iloc[:, 0] - joined.iloc[:, 1]


# --------------------------------------------------------------------------
# Position-level risk
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Concentration:
    """How much of the portfolio sits in its largest positions.

    Attributes:
        herfindahl: Sum of squared weights, in ``[1/n, 1]``.
        effective_holdings: ``1 / herfindahl`` - the number of equally sized
            positions that would carry the same concentration.
        top_five: Combined weight of the five largest positions.
        largest: Weight of the single largest position.
    """

    herfindahl: float
    effective_holdings: float
    top_five: float
    largest: float


def concentration(weights: pd.Series) -> Concentration:
    """Concentration statistics for a set of portfolio weights."""
    clean = weights.dropna().astype(float)
    if clean.empty:
        return Concentration(float("nan"), float("nan"), float("nan"), float("nan"))
    total = float(clean.sum())
    if total <= 0.0:
        return Concentration(float("nan"), float("nan"), float("nan"), float("nan"))
    normalised = clean / total
    hhi = float((normalised**2).sum())
    return Concentration(
        herfindahl=hhi,
        effective_holdings=(1.0 / hhi) if hhi else float("nan"),
        top_five=float(normalised.nlargest(5).sum()),
        largest=float(normalised.max()),
    )


def risk_contributions(
    asset_returns: pd.DataFrame,
    market_values: pd.Series,
) -> pd.DataFrame:
    """Euler decomposition of portfolio volatility by holding.

    ``sigma_p = sqrt(w' S w)``, marginal contribution ``MCR_i = (S w)_i /
    sigma_p`` and component contribution ``w_i * MCR_i``. Components sum to
    ``sigma_p``; the returned ``contribution_pct`` divides by ``sigma_p`` and
    therefore sums to 1 (negative values are possible for genuine hedges).

    The covariance is estimated on the overlapping, complete rows of the asset
    return frame, so holdings with short histories are not silently filled.
    """
    if asset_returns.empty or market_values.empty:
        return pd.DataFrame(columns=["weight", "contribution", "contribution_pct"])

    tickers = [ticker for ticker in asset_returns.columns if ticker in market_values.index]
    if not tickers:
        return pd.DataFrame(columns=["weight", "contribution", "contribution_pct"])

    aligned = asset_returns[tickers].dropna(how="any")
    values = market_values.reindex(tickers).astype(float)
    total = float(values.sum())
    if len(aligned) < 2 or total <= 0.0:
        return pd.DataFrame(columns=["weight", "contribution", "contribution_pct"])

    weights = values / total
    covariance = np.cov(aligned.to_numpy(dtype=float), rowvar=False, ddof=1)
    covariance = np.atleast_2d(covariance)
    marginal = covariance @ weights.to_numpy(dtype=float)
    variance = float(weights.to_numpy(dtype=float) @ marginal)
    if variance <= 0.0:
        return pd.DataFrame(columns=["weight", "contribution", "contribution_pct"])

    sigma = float(np.sqrt(variance))
    component = weights.to_numpy(dtype=float) * marginal / sigma
    return pd.DataFrame(
        {
            "weight": weights,
            "contribution": component,
            "contribution_pct": component / sigma,
        },
        index=weights.index,
    )


# ---------------------------------------------------------------------------
# Money-weighted return
# ---------------------------------------------------------------------------


def xnpv(rate: float, flows: Sequence[tuple[pd.Timestamp, float]]) -> float:
    """Net present value of dated cash flows at an annual rate.

    ``flows`` are ``(date, amount)`` pairs, from the investor's point of
    view: money out is negative, money in is positive.
    """
    if not flows:
        return float("nan")
    origin = flows[0][0]
    total = 0.0
    for stamp, amount in flows:
        years = (stamp - origin).days / 365.0
        total += amount / ((1.0 + rate) ** years)
    return total


def xirr(
    flows: Sequence[tuple[pd.Timestamp, float]],
    lower: float = -0.9999,
    upper: float = 10.0,
    tolerance: float = 1e-7,
    max_iterations: int = 200,
) -> float | None:
    """Annualised internal rate of return for dated cash flows.

    Solved by bisection rather than Newton's method: the NPV of a portfolio
    is not monotonic in pathological cases, and a bisection that brackets a
    sign change either converges or reports no solution. It cannot jump to a
    nonsense root the way a Newton step can.

    Returns ``None`` when there is no sign change in the bracket, which is
    the honest answer for a portfolio that never turned a profit or a loss.
    """
    if len(flows) < 2:
        return None

    low, high = lower, upper
    low_value = xnpv(low, flows)
    high_value = xnpv(high, flows)
    if not (math.isfinite(low_value) and math.isfinite(high_value)):
        return None
    if low_value * high_value > 0:
        return None

    for _ in range(max_iterations):
        middle = (low + high) / 2.0
        value = xnpv(middle, flows)
        if not math.isfinite(value):
            return None
        if abs(value) < tolerance:
            return middle
        if low_value * value <= 0:
            high = middle
            high_value = value
        else:
            low = middle
            low_value = value
    return (low + high) / 2.0


def money_weighted_return(
    flows: Sequence[tuple[pd.Timestamp, float]],
    terminal_value: float,
    final_date: pd.Timestamp,
) -> float | None:
    """Annualised IRR of a portfolio, from its cash flows and terminal value.

    The investor's cash flows are the negatives of the contributions (money
    out), and the terminal value is the money in when the portfolio is
    liquidated. Solving for the rate that discounts the two to the same
    present value gives the return on the money actually invested, which is
    not the same number as the time-weighted return when contributions are
    unevenly timed.
    """
    if terminal_value <= 0:
        return None
    series: list[tuple[pd.Timestamp, float]] = [
        (stamp, -amount) for stamp, amount in flows if amount
    ]
    series.append((pd.Timestamp(final_date), float(terminal_value)))
    if len(series) < 2:
        return None
    series.sort(key=lambda item: item[0])
    return xirr(series)


# ---------------------------------------------------------------------------
# Attribution
# ---------------------------------------------------------------------------


def active_return_attribution(
    values: pd.DataFrame,
    equity: pd.Series,
    holding_returns: pd.DataFrame,
    benchmark_returns: pd.Series,
) -> pd.Series:
    """Attribute the active return to the individual positions.

    On each day, a position earns its own return less the benchmark's, and
    that difference is multiplied by the weight the position actually had
    that day. Summing over days and positions gives the contribution of
    each position to the return above the benchmark.

    This is the single-index form of attribution: the allocation effect and
    the selection effect are combined per position, because the benchmark is
    a single index and cannot be broken into sectors. It is an arithmetic
    decomposition of the *daily* active returns, so it does not compound
    exactly into the total active return; the difference is reported as a
    residual rather than hidden.
    """
    if values.empty or equity.empty:
        return pd.Series(dtype=float)

    weights = values.div(equity, axis=0)
    aligned_returns = holding_returns.reindex(columns=values.columns)
    benchmark = benchmark_returns.reindex(aligned_returns.index)
    active = aligned_returns.sub(benchmark, axis=0)
    contribution = active.mul(weights).sum(axis=0)
    return contribution.dropna()
