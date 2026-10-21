"""Black-Scholes pricing, Option Greeks, and Options Chain service for ATLAS."""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
from scipy.stats import norm

from .schemas import (
    BlackScholesInput,
    BlackScholesOutput,
    OptionContract,
    OptionGreeks,
    OptionChainResponse,
    PayoffPoint,
)

logger = logging.getLogger(__name__)

# Sample offline chain for demo / test fallback
SAMPLE_EXPIRATIONS = ["2026-11-20", "2026-12-18", "2027-01-15", "2027-03-19", "2027-06-18"]


def calculate_black_scholes(params: BlackScholesInput) -> BlackScholesOutput:
    """Computes Black-Scholes theoretical option prices and full Greeks."""
    S = float(params.underlying_price)
    K = float(params.strike_price)
    T = max(1e-4, params.dte / 365.0)
    sigma = max(1e-4, params.volatility_pct / 100.0)
    r = max(0.0, params.risk_free_rate_pct / 100.0)
    q = max(0.0, params.dividend_yield_pct / 100.0)

    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    # Discount factors
    df_r = math.exp(-r * T)
    df_q = math.exp(-q * T)

    # Standard normal CDF and PDF
    nd1 = float(norm.cdf(d1))
    nd2 = float(norm.cdf(d2))
    n_neg_d1 = float(norm.cdf(-d1))
    n_neg_d2 = float(norm.cdf(-d2))
    pdf_d1 = float(norm.pdf(d1))

    # Option Prices
    call_price = max(0.0, S * df_q * nd1 - K * df_r * nd2)
    put_price = max(0.0, K * df_r * n_neg_d2 - S * df_q * n_neg_d1)

    # Greeks
    call_delta = df_q * nd1
    put_delta = df_q * (nd1 - 1.0)

    gamma = (df_q * pdf_d1) / (S * sigma * sqrt_T) if S > 0 else 0.0
    vega = (S * df_q * sqrt_T * pdf_d1) * 0.01  # Per 1% IV change

    call_theta = (
        -(S * df_q * pdf_d1 * sigma) / (2.0 * sqrt_T)
        - r * K * df_r * nd2
        + q * S * df_q * nd1
    ) / 365.0

    put_theta = (
        -(S * df_q * pdf_d1 * sigma) / (2.0 * sqrt_T)
        + r * K * df_r * n_neg_d2
        - q * S * df_q * n_neg_d1
    ) / 365.0

    call_rho = (K * T * df_r * nd2) * 0.01
    put_rho = (-K * T * df_r * n_neg_d2) * 0.01

    # Intrinsic & Time Value
    call_intrinsic = max(0.0, S - K)
    call_time_value = max(0.0, call_price - call_intrinsic)

    put_intrinsic = max(0.0, K - S)
    put_time_value = max(0.0, put_price - put_intrinsic)

    # Payoff curve across underlying price range (+- 30%)
    price_steps = 25
    min_price = max(1.0, S * 0.7)
    max_price = S * 1.3
    step_size = (max_price - min_price) / (price_steps - 1)

    payoff_curve: List[PayoffPoint] = []
    for step in range(price_steps):
        p = min_price + step * step_size
        call_payoff = max(0.0, p - K) - call_price
        put_payoff = max(0.0, K - p) - put_price
        payoff_curve.append(
            PayoffPoint(
                underlying_price=round(p, 2),
                call_payoff=round(call_payoff, 2),
                put_payoff=round(put_payoff, 2),
            )
        )

    return BlackScholesOutput(
        call_price=round(call_price, 2),
        put_price=round(put_price, 2),
        call_greeks=OptionGreeks(
            delta=round(call_delta, 4),
            gamma=round(gamma, 4),
            vega=round(vega, 4),
            theta=round(call_theta, 4),
            rho=round(call_rho, 4),
        ),
        put_greeks=OptionGreeks(
            delta=round(put_delta, 4),
            gamma=round(gamma, 4),
            vega=round(vega, 4),
            theta=round(put_theta, 4),
            rho=round(put_rho, 4),
        ),
        call_intrinsic=round(call_intrinsic, 2),
        call_time_value=round(call_time_value, 2),
        put_intrinsic=round(put_intrinsic, 2),
        put_time_value=round(put_time_value, 2),
        payoff_curve=payoff_curve,
    )


class OptionsService:
    """Manages real and simulated options chains and Black-Scholes analytics."""

    def __init__(self) -> None:
        self._chain_cache: Dict[str, OptionChainResponse] = {}

    def get_option_chain(
        self, ticker: str, expiry: Optional[str] = None
    ) -> OptionChainResponse:
        """Fetches options chain for ticker and expiration date."""
        clean = ticker.upper().strip()
        cache_key = f"{clean}_{expiry}"
        if cache_key in self._chain_cache:
            return self._chain_cache[cache_key]

        try:
            import yfinance as yf

            t = yf.Ticker(clean)
            expirations = list(t.options)
            if not expirations:
                return self._generate_sample_chain(clean, expiry)

            selected_exp = expiry if (expiry and expiry in expirations) else expirations[0]

            chain = t.option_chain(selected_exp)
            current_price = 0.0

            # Attempt to get underlying price
            try:
                fast = getattr(t, "fast_info", None)
                if fast and hasattr(fast, "last_price") and fast.last_price:
                    current_price = float(fast.last_price)
                else:
                    info = t.info
                    current_price = float(
                        info.get("regularMarketPrice")
                        or info.get("currentPrice")
                        or 100.0
                    )
            except Exception:
                if not chain.calls.empty:
                    current_price = float(chain.calls["strike"].median())
                else:
                    current_price = 100.0

            calls: List[OptionContract] = []
            for _, row in chain.calls.iterrows():
                strike = float(row.get("strike", 0))
                iv = float(row.get("impliedVolatility", 0.25))
                # Approximate delta
                itm = bool(row.get("inTheMoney", strike < current_price))
                calls.append(
                    OptionContract(
                        contract_symbol=str(row.get("contractSymbol", "")),
                        strike=round(strike, 2),
                        last_price=round(float(row.get("lastPrice", 0)), 2),
                        bid=round(float(row.get("bid", 0)), 2) if row.get("bid") else None,
                        ask=round(float(row.get("ask", 0)), 2) if row.get("ask") else None,
                        volume=int(row.get("volume", 0)) if row.get("volume") and not np.isnan(row.get("volume")) else 0,
                        open_interest=int(row.get("openInterest", 0)) if row.get("openInterest") and not np.isnan(row.get("openInterest")) else 0,
                        implied_volatility=round(iv, 4),
                        in_the_money=itm,
                        delta=round(0.7 if itm else 0.3, 2),
                        gamma=round(0.02, 4),
                        vega=round(0.25, 4),
                        theta=round(-0.05, 4),
                    )
                )

            puts: List[OptionContract] = []
            for _, row in chain.puts.iterrows():
                strike = float(row.get("strike", 0))
                iv = float(row.get("impliedVolatility", 0.25))
                itm = bool(row.get("inTheMoney", strike > current_price))
                puts.append(
                    OptionContract(
                        contract_symbol=str(row.get("contractSymbol", "")),
                        strike=round(strike, 2),
                        last_price=round(float(row.get("lastPrice", 0)), 2),
                        bid=round(float(row.get("bid", 0)), 2) if row.get("bid") else None,
                        ask=round(float(row.get("ask", 0)), 2) if row.get("ask") else None,
                        volume=int(row.get("volume", 0)) if row.get("volume") and not np.isnan(row.get("volume")) else 0,
                        open_interest=int(row.get("openInterest", 0)) if row.get("openInterest") and not np.isnan(row.get("openInterest")) else 0,
                        implied_volatility=round(iv, 4),
                        in_the_money=itm,
                        delta=round(-0.3 if not itm else -0.7, 2),
                        gamma=round(0.02, 4),
                        vega=round(0.25, 4),
                        theta=round(-0.04, 4),
                    )
                )

            res = OptionChainResponse(
                ticker=clean,
                underlying_price=round(current_price, 2),
                expirations=expirations,
                selected_expiration=selected_exp,
                calls=calls,
                puts=puts,
            )
            self._chain_cache[cache_key] = res
            return res

        except Exception as exc:
            logger.warning("Failed to fetch live option chain for %s: %s", clean, exc)
            return self._generate_sample_chain(clean, expiry)

    def _generate_sample_chain(
        self, ticker: str, expiry: Optional[str] = None
    ) -> OptionChainResponse:
        """Generates realistic synthetic options chain for offline / demo mode."""
        clean = ticker.upper().strip()
        base_price = 230.0 if clean == "AAPL" else 135.0 if clean == "NVDA" else 150.0
        expirations = SAMPLE_EXPIRATIONS
        selected_exp = expiry or expirations[0]

        strikes = [round(base_price * (0.8 + 0.02 * i), 1) for i in range(21)]
        calls: List[OptionContract] = []
        puts: List[OptionContract] = []

        for k in strikes:
            c_inp = BlackScholesInput(
                underlying_price=base_price,
                strike_price=k,
                dte=30,
                volatility_pct=25.0,
                risk_free_rate_pct=4.5,
                dividend_yield_pct=0.5,
            )
            c_res = calculate_black_scholes(c_inp)

            calls.append(
                OptionContract(
                    contract_symbol=f"{clean}{selected_exp.replace('-', '')}C{int(k*1000):08d}",
                    strike=k,
                    last_price=c_res.call_price,
                    bid=round(c_res.call_price * 0.98, 2),
                    ask=round(c_res.call_price * 1.02, 2),
                    volume=120,
                    open_interest=540,
                    implied_volatility=0.25,
                    in_the_money=k < base_price,
                    delta=c_res.call_greeks.delta,
                    gamma=c_res.call_greeks.gamma,
                    vega=c_res.call_greeks.vega,
                    theta=c_res.call_greeks.theta,
                )
            )

            puts.append(
                OptionContract(
                    contract_symbol=f"{clean}{selected_exp.replace('-', '')}P{int(k*1000):08d}",
                    strike=k,
                    last_price=c_res.put_price,
                    bid=round(c_res.put_price * 0.98, 2),
                    ask=round(c_res.put_price * 1.02, 2),
                    volume=95,
                    open_interest=410,
                    implied_volatility=0.25,
                    in_the_money=k > base_price,
                    delta=c_res.put_greeks.delta,
                    gamma=c_res.put_greeks.gamma,
                    vega=c_res.put_greeks.vega,
                    theta=c_res.put_greeks.theta,
                )
            )

        return OptionChainResponse(
            ticker=clean,
            underlying_price=base_price,
            expirations=expirations,
            selected_expiration=selected_exp,
            calls=calls,
            puts=puts,
        )


_options_service: Optional[OptionsService] = None


def get_options_service() -> OptionsService:
    global _options_service
    if _options_service is None:
        _options_service = OptionsService()
    return _options_service
