"""Fixed Income & Yield Curve analytics service for ATLAS.

Provides Treasury yield curve analysis, credit spread tracking,
and bond pricing / duration / convexity calculations.
"""
from __future__ import annotations

import logging
import math
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .schemas import (
    BondCalculatorInput,
    BondCalculatorOutput,
    HistoricalYieldPoint,
    RateShockScenario,
    YieldCurveSnapshot,
    YieldPoint,
)

logger = logging.getLogger(__name__)

# Standard Treasury Tenors in ascending maturity order
TREASURY_TENORS: List[Tuple[str, str, float]] = [
    ("DGS1MO", "1M", 1 / 12),
    ("DGS3MO", "3M", 3 / 12),
    ("DGS6MO", "6M", 6 / 12),
    ("DGS1", "1Y", 1.0),
    ("DGS2", "2Y", 2.0),
    ("DGS5", "5Y", 5.0),
    ("DGS7", "7Y", 7.0),
    ("DGS10", "10Y", 10.0),
    ("DGS20", "20Y", 20.0),
    ("DGS30", "30Y", 30.0),
]

SERIES_NAMES: Dict[str, str] = {
    "DGS1MO": "1-Month Treasury Constant Maturity Rate",
    "DGS3MO": "3-Month Treasury Constant Maturity Rate",
    "DGS6MO": "6-Month Treasury Constant Maturity Rate",
    "DGS1": "1-Year Treasury Constant Maturity Rate",
    "DGS2": "2-Year Treasury Constant Maturity Rate",
    "DGS5": "5-Year Treasury Constant Maturity Rate",
    "DGS7": "7-Year Treasury Constant Maturity Rate",
    "DGS10": "10-Year Treasury Constant Maturity Rate",
    "DGS20": "20-Year Treasury Constant Maturity Rate",
    "DGS30": "30-Year Treasury Constant Maturity Rate",
    "AAA": "Moody's Seasoned Aaa Corporate Bond Yield",
    "BAA": "Moody's Seasoned Baa Corporate Bond Yield",
    "T10Y2Y": "10-Year minus 2-Year Treasury Yield Spread",
}


class FixedIncomeService:
    """Manages cached bond and yield curve datasets and runs fixed income analytics."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        if data_dir is None:
            # Default to backend/data/fixed_income
            base_dir = Path(__file__).resolve().parent.parent / "data" / "fixed_income"
            self.data_dir = base_dir
        else:
            self.data_dir = Path(data_dir)

        self._series_cache: Dict[str, pd.DataFrame] = {}
        self._load_all()

    def _load_all(self) -> None:
        """Loads parquet data files into memory cache if available."""
        if not self.data_dir.exists():
            return

        all_keys = [sid for sid, _, _ in TREASURY_TENORS] + ["AAA", "BAA", "T10Y2Y"]
        for key in all_keys:
            file_path = self.data_dir / f"{key.lower()}.parquet"
            if file_path.exists():
                try:
                    df = pd.read_parquet(file_path)
                    df = df.dropna()
                    if not isinstance(df.index, pd.DatetimeIndex):
                        df.index = pd.to_datetime(df.index)
                    self._series_cache[key] = df.sort_index()
                except Exception:
                    logger.exception("Could not read fixed income series %s", file_path)

    def get_series(self, series_id: str) -> pd.DataFrame:
        """Returns the date-indexed DataFrame for a series."""
        sid = series_id.upper()
        if sid in self._series_cache:
            return self._series_cache[sid]

        file_path = self.data_dir / f"{sid.lower()}.parquet"
        if file_path.exists():
            try:
                df = pd.read_parquet(file_path).dropna()
                if not isinstance(df.index, pd.DatetimeIndex):
                    df.index = pd.to_datetime(df.index)
                sorted_df = df.sort_index()
                self._series_cache[sid] = sorted_df
                return sorted_df
            except Exception:
                logger.exception("Could not read fixed income series %s", file_path)
                return pd.DataFrame()
        return pd.DataFrame()

    def get_latest_date(self) -> Optional[datetime]:
        """Returns the most recent common date available in the primary 10Y series."""
        df = self.get_series("DGS10")
        if not df.empty:
            return df.index.max().to_pydatetime()
        # Fallback to any series
        for df in self._series_cache.values():
            if not df.empty:
                return df.index.max().to_pydatetime()
        return None

    def _get_yield_at(self, series_id: str, target_date: datetime) -> Optional[float]:
        df = self.get_series(series_id)
        if df.empty:
            return None
        sub = df.loc[df.index <= target_date]
        if sub.empty:
            return None
        val = sub.iloc[-1]["yield"]
        return float(val) if pd.notna(val) else None

    def _build_curve_points(self, target_date: datetime) -> List[YieldPoint]:
        points: List[YieldPoint] = []
        for sid, tenor, years in TREASURY_TENORS:
            y = self._get_yield_at(sid, target_date)
            if y is not None:
                points.append(
                    YieldPoint(
                        tenor=tenor,
                        series_id=sid,
                        years=round(years, 4),
                        yield_pct=round(y, 3),
                    )
                )
        return points

    def get_yield_curve(self, as_of: Optional[str] = None) -> YieldCurveSnapshot:
        """Builds a complete Yield Curve snapshot with comparative history and spreads."""
        if as_of:
            try:
                target_dt = datetime.strptime(as_of, "%Y-%m-%d")
            except ValueError:
                target_dt = self.get_latest_date() or datetime.now()
        else:
            target_dt = self.get_latest_date() or datetime.now()

        # Build current curve
        current_curve = self._build_curve_points(target_dt)

        # 1 Month ago and 1 Year ago curves
        dt_1m_ago = target_dt - timedelta(days=30)
        dt_1y_ago = target_dt - timedelta(days=365)
        curve_1m = self._build_curve_points(dt_1m_ago)
        curve_1y = self._build_curve_points(dt_1y_ago)

        # Key Treasury benchmarks
        us10y = self._get_yield_at("DGS10", target_dt) or 0.0
        us2y = self._get_yield_at("DGS2", target_dt) or 0.0
        us3m = self._get_yield_at("DGS3MO", target_dt) or 0.0

        spread_10y_2y_bps = round((us10y - us2y) * 100, 1)
        spread_10y_3m_bps = round((us10y - us3m) * 100, 1)

        # Curve shape status
        if spread_10y_2y_bps < -5.0:
            curve_status = "INVERTED"
        elif abs(spread_10y_2y_bps) <= 5.0:
            curve_status = "FLAT"
        else:
            curve_status = "NORMAL"

        # Corporate Credit Spreads
        aaa_yield = self._get_yield_at("AAA", target_dt)
        baa_yield = self._get_yield_at("BAA", target_dt)

        credit_spread_baa_aaa_bps: Optional[float] = None
        credit_spread_baa_10y_bps: Optional[float] = None

        if baa_yield is not None and aaa_yield is not None:
            credit_spread_baa_aaa_bps = round((baa_yield - aaa_yield) * 100, 1)
        if baa_yield is not None and us10y > 0:
            credit_spread_baa_10y_bps = round((baa_yield - us10y) * 100, 1)

        return YieldCurveSnapshot(
            as_of_date=target_dt.strftime("%Y-%m-%d"),
            curve_points=current_curve,
            curve_points_1m_ago=curve_1m if curve_1m else None,
            curve_points_1y_ago=curve_1y if curve_1y else None,
            spread_10y_2y_bps=spread_10y_2y_bps,
            spread_10y_3m_bps=spread_10y_3m_bps,
            curve_status=curve_status,
            us10y_yield=round(us10y, 3),
            us2y_yield=round(us2y, 3),
            us3m_yield=round(us3m, 3),
            aaa_yield=round(aaa_yield, 3) if aaa_yield is not None else None,
            baa_yield=round(baa_yield, 3) if baa_yield is not None else None,
            credit_spread_baa_aaa_bps=credit_spread_baa_aaa_bps,
            credit_spread_baa_10y_bps=credit_spread_baa_10y_bps,
        )

    def get_historical_series(
        self, range_key: str = "1Y"
    ) -> List[HistoricalYieldPoint]:
        """Returns aligned time series for multi-series trend charting."""
        latest_dt = self.get_latest_date() or datetime.now()

        range_days = {
            "1M": 30,
            "6M": 180,
            "1Y": 365,
            "3Y": 365 * 3,
            "5Y": 365 * 5,
            "10Y": 365 * 10,
            "MAX": 365 * 30,
        }
        days = range_days.get(range_key.upper(), 365)
        start_dt = latest_dt - timedelta(days=days)

        # Primary series
        s_10y = self.get_series("DGS10")
        s_2y = self.get_series("DGS2")
        s_3m = self.get_series("DGS3MO")
        s_spread = self.get_series("T10Y2Y")
        s_aaa = self.get_series("AAA")
        s_baa = self.get_series("BAA")

        if s_10y.empty:
            return []

        # Filter window
        mask = (s_10y.index >= start_dt) & (s_10y.index <= latest_dt)
        filtered_index = s_10y.loc[mask].index

        # Downsample for large ranges to keep UI fast
        step = 1
        if days > 365 * 5:
            step = 5  # weekly
        elif days > 365 * 2:
            step = 2

        sampled_index = filtered_index[::step]
        points: List[HistoricalYieldPoint] = []

        for dt in sampled_index:
            dt_str = dt.strftime("%Y-%m-%d")

            val_10y = s_10y.loc[dt, "yield"] if dt in s_10y.index else None
            val_2y = s_2y.loc[dt, "yield"] if dt in s_2y.index else None
            val_3m = s_3m.loc[dt, "yield"] if dt in s_3m.index else None
            val_spread = s_spread.loc[dt, "yield"] if dt in s_spread.index else None

            # For monthly series (AAA and BAA), get most recent observation on or before dt
            val_aaa = None
            if not s_aaa.empty:
                sub_aaa = s_aaa.loc[s_aaa.index <= dt]
                if not sub_aaa.empty:
                    val_aaa = float(sub_aaa.iloc[-1]["yield"])

            val_baa = None
            if not s_baa.empty:
                sub_baa = s_baa.loc[s_baa.index <= dt]
                if not sub_baa.empty:
                    val_baa = float(sub_baa.iloc[-1]["yield"])

            points.append(
                HistoricalYieldPoint(
                    date=dt_str,
                    dgs10=round(float(val_10y), 3) if pd.notna(val_10y) else None,
                    dgs2=round(float(val_2y), 3) if pd.notna(val_2y) else None,
                    dgs3mo=round(float(val_3m), 3) if pd.notna(val_3m) else None,
                    t10y2y=round(float(val_spread), 3) if pd.notna(val_spread) else None,
                    aaa=round(val_aaa, 3) if val_aaa is not None else None,
                    baa=round(val_baa, 3) if val_baa is not None else None,
                )
            )

        return points

    @staticmethod
    def calculate_bond_metrics(params: BondCalculatorInput) -> BondCalculatorOutput:
        """Institutional-grade bond pricing, duration, convexity, and rate shock analytics."""
        face = params.face_value
        coupon_pct = params.coupon_rate
        ytm_pct = params.ytm
        years = params.years_to_maturity
        freq = max(1, params.frequency)

        total_periods = max(1, int(round(years * freq)))
        coupon_per_period = face * (coupon_pct / 100.0) / freq
        y_per_period = (ytm_pct / 100.0) / freq

        # Calculate present value of periodic cash flows
        pv_cash_flows: List[float] = []
        times_in_years: List[float] = []

        for period in range(1, total_periods + 1):
            is_final = period == total_periods
            cash_flow = coupon_per_period + (face if is_final else 0.0)
            df = (1.0 + y_per_period) ** (-period)
            pv = cash_flow * df
            pv_cash_flows.append(pv)
            times_in_years.append(period / freq)

        price = sum(pv_cash_flows)
        clean_price = price  # No accrued interest assuming coupon date

        # Macaulay Duration (years)
        macaulay_duration = (
            sum(t * pv for t, pv in zip(times_in_years, pv_cash_flows)) / price
            if price > 0
            else 0.0
        )

        # Modified Duration (years)
        modified_duration = (
            macaulay_duration / (1.0 + y_per_period) if (1.0 + y_per_period) > 0 else 0.0
        )

        # Convexity
        convexity_sum = 0.0
        for period in range(1, total_periods + 1):
            is_final = period == total_periods
            cash_flow = coupon_per_period + (face if is_final else 0.0)
            df = (1.0 + y_per_period) ** (-period)
            convexity_sum += period * (period + 1) * cash_flow * df

        convexity = (
            convexity_sum / (price * ((1.0 + y_per_period) ** 2) * (freq**2))
            if price > 0
            else 0.0
        )

        # DV01 (Dollar Value of 1 Basis Point)
        dv01 = modified_duration * price * 0.0001

        annual_coupon_income = face * (coupon_pct / 100.0)
        current_yield = (annual_coupon_income / price * 100.0) if price > 0 else 0.0

        # Scenario analysis for standard rate shocks
        shock_bps_list = [-200, -100, -50, -25, 25, 50, 100, 200]
        scenarios: List[RateShockScenario] = []

        for shock_bps in shock_bps_list:
            shock_pct = shock_bps / 100.0
            new_ytm = max(0.001, ytm_pct + shock_pct)
            new_y_per_period = (new_ytm / 100.0) / freq

            # Exact re-pricing at shocked yield
            repriced = 0.0
            for period in range(1, total_periods + 1):
                is_final = period == total_periods
                cf = coupon_per_period + (face if is_final else 0.0)
                repriced += cf * ((1.0 + new_y_per_period) ** (-period))

            change_dollars = repriced - price
            change_pct = (change_dollars / price * 100.0) if price > 0 else 0.0

            scenarios.append(
                RateShockScenario(
                    shift_bps=shock_bps,
                    new_ytm=round(new_ytm, 3),
                    repriced_bond=round(repriced, 2),
                    price_change_dollars=round(change_dollars, 2),
                    price_change_pct=round(change_pct, 2),
                )
            )

        return BondCalculatorOutput(
            price=round(price, 2),
            clean_price=round(clean_price, 2),
            macaulay_duration=round(macaulay_duration, 3),
            modified_duration=round(modified_duration, 3),
            convexity=round(convexity, 3),
            dv01=round(dv01, 3),
            annual_coupon_income=round(annual_coupon_income, 2),
            current_yield=round(current_yield, 2),
            scenarios=scenarios,
        )


# Global singleton instance
_fi_service: Optional[FixedIncomeService] = None


def get_fixed_income_service() -> FixedIncomeService:
    global _fi_service
    if _fi_service is None:
        _fi_service = FixedIncomeService()
    return _fi_service
