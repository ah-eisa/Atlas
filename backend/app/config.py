"""Central configuration for the portfolio analytics backend.

Every tunable lives here so the app can be re-pointed at a different portfolio,
benchmark, or risk convention without touching computation code. Values may be
overridden with environment variables, which is how the Docker image and local
deployments are configured.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_DIR: Path = Path(__file__).resolve().parent
BACKEND_DIR: Path = APP_DIR.parent
REPO_ROOT: Path = BACKEND_DIR.parent


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None and value.strip() else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw and raw.strip() else default


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return tuple(item.strip() for item in raw.split(",") if item.strip())


DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
)


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings.

    Attributes:
        base_currency: Fallback reporting currency used when the store has no
            explicit setting.
        benchmark: yfinance symbol used for beta and relative comparisons.
        history_years: Years of daily history to fetch.
        trading_days_per_year: Annualisation factor for volatility/Sharpe.
        risk_free_rate: Annual risk-free rate as a decimal (0.02 == 2%).
        var_confidences: Confidence levels for Value at Risk.
        mc_paths: Number of Monte Carlo paths.
        mc_horizon_days: Simulation horizon in trading days (252 ~ 1 year).
        mc_seed: RNG seed; fixed so snapshots are reproducible.
        mc_batch_paths: Paths simulated per batch, to bound peak memory.
        mc_histogram_bins: Bin count for the final-value histogram.
        money_dp: Decimal places for monetary values.
        ratio_dp: Decimal places for ratios, betas and percentages.
        cache_ttl_hours: Age at which the on-disk price cache is refetched.
        cors_origins: Allowed browser origins for the API.
        api_key: Optional shared secret. When set, every API route except
            health requires an ``X-API-Key`` header.
        db_path: SQLite database holding the user's positions.
        seed_demo: Import ``holdings.json`` on first boot when the store is
            empty. Never overwrites positions afterwards.
        report_scheduler: Run scheduled reports in the background while the
            API is up.
        benchmark_includes_dividends: Whether the benchmark index is a total
            return series. The portfolio's own returns include its dividends
            (credited as cash), so comparing them with a price-only index
            biases alpha downwards by roughly the portfolio's dividend yield.
    """

    base_currency: str = "EUR"
    benchmark: str = "^SP500TR"
    benchmark_name: str = "S&P 500 (total return)"
    benchmark_includes_dividends: bool = True

    history_years: int = 2
    trading_days_per_year: int = 252
    risk_free_rate: float = 0.02
    var_confidences: tuple[float, ...] = (0.95, 0.99)

    mc_paths: int = 10_000
    mc_horizon_days: int = 252
    mc_seed: int = 20240517
    mc_batch_paths: int = 1_000
    mc_histogram_bins: int = 48

    money_dp: int = 2
    ratio_dp: int = 4

    cache_ttl_hours: float = 12.0

    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS

    api_key: str = ""
    db_path: Path = field(default=BACKEND_DIR / "data" / "portfolio.db")
    seed_demo: bool = True
    report_scheduler: bool = True

    holdings_path: Path = field(default=BACKEND_DIR / "holdings.json")
    cache_dir: Path = field(default=BACKEND_DIR / ".cache")
    snapshot_path: Path = field(default=REPO_ROOT / "snapshot.json")
    frontend_dist: Path = field(default=REPO_ROOT / "frontend" / "dist")

    @property
    def daily_risk_free_rate(self) -> float:
        """Risk-free rate per trading day, de-annualised geometrically.

        Formula: ``(1 + rf_annual) ** (1 / trading_days) - 1``
        """
        return (1.0 + self.risk_free_rate) ** (1.0 / self.trading_days_per_year) - 1.0

    @property
    def requires_api_key(self) -> bool:
        return bool(self.api_key)


def load_settings() -> Settings:
    """Build settings from the environment, validating obvious mistakes early."""
    years = _env_int("PORTFOLIO_HISTORY_YEARS", 2)
    if not 1 <= years <= 15:
        raise ValueError("PORTFOLIO_HISTORY_YEARS must be between 1 and 15")

    risk_free = _env_float("PORTFOLIO_RISK_FREE_RATE", 0.02)
    if not -0.5 <= risk_free <= 1.0:
        raise ValueError("PORTFOLIO_RISK_FREE_RATE must be a decimal fraction (0.02 = 2%)")

    ttl = _env_float("PORTFOLIO_CACHE_TTL_HOURS", 12.0)
    if ttl < 0:
        raise ValueError("PORTFOLIO_CACHE_TTL_HOURS must be non-negative")

    paths = _env_int("PORTFOLIO_MC_PATHS", 10_000)
    if not 100 <= paths <= 200_000:
        raise ValueError("PORTFOLIO_MC_PATHS must be between 100 and 200000")

    horizon = _env_int("PORTFOLIO_MC_HORIZON_DAYS", 252)
    if not 20 <= horizon <= 2_520:
        raise ValueError("PORTFOLIO_MC_HORIZON_DAYS must be between 20 and 2520")

    return Settings(
        base_currency=_env_str("PORTFOLIO_BASE_CURRENCY", "EUR").upper(),
        benchmark=_env_str("PORTFOLIO_BENCHMARK", "^SP500TR"),
        benchmark_name=_env_str("PORTFOLIO_BENCHMARK_NAME", "S&P 500 (total return)"),
        benchmark_includes_dividends=_env_bool("PORTFOLIO_BENCHMARK_INCLUDES_DIVIDENDS", True),
        history_years=years,
        risk_free_rate=risk_free,
        mc_paths=paths,
        mc_horizon_days=horizon,
        cache_ttl_hours=ttl,
        cors_origins=_env_list("PORTFOLIO_CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
        api_key=_env_str("PORTFOLIO_API_KEY", ""),
        db_path=_env_path("PORTFOLIO_DB_PATH", BACKEND_DIR / "data" / "portfolio.db"),
        seed_demo=_env_bool("PORTFOLIO_SEED_DEMO", True),
        report_scheduler=_env_bool("PORTFOLIO_REPORT_SCHEDULER", True),
        holdings_path=_env_path("PORTFOLIO_HOLDINGS_PATH", BACKEND_DIR / "holdings.json"),
        cache_dir=_env_path("PORTFOLIO_CACHE_DIR", BACKEND_DIR / ".cache"),
        snapshot_path=_env_path("PORTFOLIO_SNAPSHOT_PATH", REPO_ROOT / "snapshot.json"),
        frontend_dist=_env_path("PORTFOLIO_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist"),
    )


SETTINGS = load_settings()
