"""Scheduled reports: a portfolio statement written to disk on a schedule.

A schedule says which portfolio, how often (``daily``, ``weekly`` on a
weekday, ``monthly`` on a day of the month) and at what hour of the server's
local time. A background thread started with the API wakes every minute and
runs what is due; "run now" does the same on demand. Each run builds the
analytics afresh and writes one self-contained HTML statement - the value
and its changes, performance against the benchmark, the holdings, income and
charges, sleeves, the compliance check and the factsheet's memo - under
``<data>/reports/portfolio-<id>/``. Every run is recorded, with its file or
the error that stopped it, and in the audit trail.

Delivery (e-mail, a shared drive) is left to whatever watches that folder.
"""

from __future__ import annotations

import html
import logging
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import audit
from .config import SETTINGS, Settings
from .store import DEFAULT_PORTFOLIO_ID, StoreError, _now, connect

logger = logging.getLogger(__name__)

FREQUENCIES = ("daily", "weekly", "monthly")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


class ScheduleError(StoreError):
    """A schedule that cannot run as written."""


class ScheduleNotFound(StoreError):
    """No such schedule or run."""


def _local_now() -> datetime:
    return datetime.now().astimezone()


def next_run(
    frequency: str, weekday: int, monthday: int, hour: int, after: datetime
) -> datetime:
    """The first time strictly after ``after`` that the schedule is due."""
    candidate = after.replace(hour=hour, minute=0, second=0, microsecond=0)
    if frequency == "daily":
        if candidate <= after:
            candidate += timedelta(days=1)
        return candidate
    if frequency == "weekly":
        candidate += timedelta(days=(weekday - candidate.weekday()) % 7)
        if candidate <= after:
            candidate += timedelta(days=7)
        return candidate
    # Monthly: a day past the end of a short month runs on its last day.
    year, month = candidate.year, candidate.month
    for _ in range(3):
        last_day = (datetime(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day
        due = candidate.replace(year=year, month=month, day=min(monthday, last_day))
        if due > after:
            return due
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    raise ScheduleError("no next run could be found")


def _validate(data: dict[str, Any]) -> tuple[str, str, int, int, int]:
    name = str(data.get("name") or "").strip()[:80] or "Statement"
    frequency = str(data.get("frequency") or "").lower()
    if frequency not in FREQUENCIES:
        raise ScheduleError("frequency must be daily, weekly or monthly")
    weekday = int(data.get("weekday") or 0)
    monthday = int(data.get("monthday") or 1)
    hour = int(data.get("hour") if data.get("hour") is not None else 7)
    if not 0 <= weekday <= 6:
        raise ScheduleError("weekday is 0 (Monday) to 6 (Sunday)")
    if not 1 <= monthday <= 31:
        raise ScheduleError("day of the month is 1 to 31")
    if not 0 <= hour <= 23:
        raise ScheduleError("hour is 0 to 23")
    return name, frequency, weekday, monthday, hour


def _schedule_dict(row: Any) -> dict[str, Any]:
    frequency = str(row["frequency"])
    when = f"at {int(row['hour']):02d}:00"
    if frequency == "weekly":
        when = f"every {WEEKDAYS[int(row['weekday'])]} {when}"
    elif frequency == "monthly":
        when = f"on day {int(row['monthday'])} of every month {when}"
    else:
        when = f"every day {when}"
    return {
        "id": int(row["id"]),
        "portfolio_id": int(row["portfolio_id"]),
        "name": str(row["name"]),
        "frequency": frequency,
        "weekday": int(row["weekday"]),
        "monthday": int(row["monthday"]),
        "hour": int(row["hour"]),
        "enabled": bool(row["enabled"]),
        "description": when,
        "last_run_at": row["last_run_at"],
        "next_run_at": str(row["next_run_at"]),
        "created_at": str(row["created_at"]),
    }


def list_schedules(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            "SELECT * FROM report_schedules WHERE portfolio_id = ? ORDER BY id", (portfolio_id,)
        ).fetchall()
    return [_schedule_dict(row) for row in rows]


def create_schedule(
    data: dict[str, Any], settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> dict[str, Any]:
    name, frequency, weekday, monthday, hour = _validate(data)
    due = next_run(frequency, weekday, monthday, hour, _local_now())
    with connect(settings) as connection:
        cursor = connection.execute(
            """
            INSERT INTO report_schedules
                (portfolio_id, name, frequency, weekday, monthday, hour, next_run_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (portfolio_id, name, frequency, weekday, monthday, hour, due.isoformat(timespec="seconds"), _now()),
        )
        audit.record(
            connection,
            portfolio_id,
            "report.schedule",
            "report_schedule",
            cursor.lastrowid,
            {"name": name, "frequency": frequency, "weekday": weekday, "monthday": monthday, "hour": hour},
        )
        row = connection.execute(
            "SELECT * FROM report_schedules WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return _schedule_dict(row)


def set_schedule_enabled(
    schedule_id: int,
    enabled: bool,
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
) -> dict[str, Any]:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT * FROM report_schedules WHERE id = ? AND portfolio_id = ?",
            (schedule_id, portfolio_id),
        ).fetchone()
        if row is None:
            raise ScheduleNotFound(f"no schedule with id {schedule_id}")
        # Turned back on, it runs at its next slot from now, not at once for
        # every slot it missed.
        due = next_run(
            str(row["frequency"]), int(row["weekday"]), int(row["monthday"]), int(row["hour"]), _local_now()
        )
        connection.execute(
            "UPDATE report_schedules SET enabled = ?, next_run_at = ? WHERE id = ?",
            (1 if enabled else 0, due.isoformat(timespec="seconds"), schedule_id),
        )
        audit.record(
            connection,
            portfolio_id,
            "report.enable" if enabled else "report.disable",
            "report_schedule",
            schedule_id,
        )
        row = connection.execute("SELECT * FROM report_schedules WHERE id = ?", (schedule_id,)).fetchone()
    return _schedule_dict(row)


def delete_schedule(
    schedule_id: int, settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> None:
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT name FROM report_schedules WHERE id = ? AND portfolio_id = ?",
            (schedule_id, portfolio_id),
        ).fetchone()
        if row is None:
            raise ScheduleNotFound(f"no schedule with id {schedule_id}")
        connection.execute("DELETE FROM report_schedules WHERE id = ?", (schedule_id,))
        audit.record(
            connection,
            portfolio_id,
            "report.unschedule",
            "report_schedule",
            schedule_id,
            {"name": str(row["name"])},
        )


def list_runs(
    settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID, limit: int = 50
) -> list[dict[str, Any]]:
    with connect(settings) as connection:
        rows = connection.execute(
            """
            SELECT r.*, s.name AS schedule_name FROM report_runs r
            LEFT JOIN report_schedules s ON s.id = r.schedule_id
            WHERE r.portfolio_id = ? ORDER BY r.id DESC LIMIT ?
            """,
            (portfolio_id, limit),
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "schedule_id": row["schedule_id"],
            "schedule_name": row["schedule_name"] or "Run on demand",
            "started_at": str(row["started_at"]),
            "finished_at": row["finished_at"],
            "status": str(row["status"]),
            "file": Path(row["path"]).name if row["path"] else None,
            "error": row["error"],
        }
        for row in rows
    ]


def run_file(
    run_id: int, settings: Settings = SETTINGS, portfolio_id: int = DEFAULT_PORTFOLIO_ID
) -> Path:
    """The statement a run wrote, checked to be inside the reports folder."""
    with connect(settings) as connection:
        row = connection.execute(
            "SELECT path FROM report_runs WHERE id = ? AND portfolio_id = ? AND status = 'done'",
            (run_id, portfolio_id),
        ).fetchone()
    if row is None or not row["path"]:
        raise ScheduleNotFound(f"no finished report run with id {run_id}")
    path = Path(row["path"]).resolve()
    root = reports_dir(settings).resolve()
    if root not in path.parents or not path.exists():
        raise ScheduleNotFound(f"the file of run {run_id} is no longer there")
    return path


def reports_dir(settings: Settings = SETTINGS) -> Path:
    return settings.db_path.parent / "reports"


# ---------------------------------------------------------------------------
# Running a report
# ---------------------------------------------------------------------------


def run_report(
    settings: Settings = SETTINGS,
    portfolio_id: int = DEFAULT_PORTFOLIO_ID,
    schedule_id: int | None = None,
    *,
    analytics: Any = None,
) -> dict[str, Any]:
    """Build the analytics, write the statement, and record the run.

    ``analytics`` can be passed in (the API passes its cached instance for a
    run on demand); a scheduled run builds its own.
    """
    started = _now()
    with connect(settings) as connection:
        cursor = connection.execute(
            "INSERT INTO report_runs (schedule_id, portfolio_id, started_at, status) VALUES (?, ?, ?, 'running')",
            (schedule_id, portfolio_id, started),
        )
        run_id = int(cursor.lastrowid)
        schedule = (
            connection.execute("SELECT name FROM report_schedules WHERE id = ?", (schedule_id,)).fetchone()
            if schedule_id is not None
            else None
        )
        portfolio = connection.execute(
            "SELECT name FROM portfolios WHERE id = ?", (portfolio_id,)
        ).fetchone()
    title = str(schedule["name"]) if schedule is not None else "Statement"
    portfolio_name = str(portfolio["name"]) if portfolio is not None else f"Portfolio {portfolio_id}"

    path: Path | None = None
    error: str | None = None
    try:
        if analytics is None:
            from .portfolio import build_analytics
            from .store import build_portfolio

            analytics = build_analytics(settings, portfolio=build_portfolio(settings, portfolio_id))
        document = render_statement(analytics, settings, portfolio_id, portfolio_name, title)
        folder = reports_dir(settings) / f"portfolio-{portfolio_id}"
        folder.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "statement"
        path = folder / f"{analytics.as_of}-{slug}-{run_id}.html"
        path.write_text(document, encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 - a failed run is recorded, not raised
        logger.exception("Report run %d for portfolio %d failed", run_id, portfolio_id)
        error = str(exc)[:500]

    with connect(settings) as connection:
        connection.execute(
            "UPDATE report_runs SET finished_at = ?, status = ?, path = ?, error = ? WHERE id = ?",
            (_now(), "failed" if error else "done", str(path) if path else None, error, run_id),
        )
        audit.record(
            connection,
            portfolio_id,
            "report.run",
            "report_run",
            run_id,
            {"schedule_id": schedule_id, "status": "failed" if error else "done", "error": error},
        )
    return next(run for run in list_runs(settings, portfolio_id) if run["id"] == run_id)


def run_due(settings: Settings = SETTINGS, now: datetime | None = None) -> int:
    """Run every enabled schedule that is due, and move each to its next slot."""
    moment = now or _local_now()
    with connect(settings) as connection:
        rows = connection.execute("SELECT * FROM report_schedules WHERE enabled = 1").fetchall()
    due = [row for row in rows if datetime.fromisoformat(str(row["next_run_at"])) <= moment]
    for row in due:
        token = audit.ACTOR.set("scheduler")
        try:
            run_report(settings, int(row["portfolio_id"]), int(row["id"]))
        finally:
            audit.ACTOR.reset(token)
        following = next_run(
            str(row["frequency"]), int(row["weekday"]), int(row["monthday"]), int(row["hour"]), moment
        )
        with connect(settings) as connection:
            connection.execute(
                "UPDATE report_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?",
                (moment.isoformat(timespec="seconds"), following.isoformat(timespec="seconds"), row["id"]),
            )
    return len(due)


class Scheduler:
    """Wakes every ``interval`` seconds and runs the reports that are due."""

    def __init__(self, settings: Settings = SETTINGS, interval: float = 60.0) -> None:
        self.settings = settings
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="report-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                ran = run_due(self.settings)
                if ran:
                    logger.info("Ran %d scheduled report(s)", ran)
            except Exception:  # noqa: BLE001 - the scheduler must outlive one bad run
                logger.exception("The report scheduler failed this round")


# ---------------------------------------------------------------------------
# The statement
# ---------------------------------------------------------------------------


def _money(value: Any, currency: str = "") -> str:
    if value is None:
        return "—"
    text = f"{float(value):,.2f}"
    return f"{text} {currency}".strip()


def _signed(value: Any, currency: str = "") -> str:
    if value is None:
        return "—"
    text = f"{float(value):+,.2f}"
    return f"{text} {currency}".strip()


def _pct(value: Any, digits: int = 2, signed: bool = False) -> str:
    if value is None:
        return "—"
    return f"{float(value) * 100:{'+' if signed else ''}.{digits}f}%"


def _tone(value: Any) -> str:
    if value is None:
        return ""
    return "pos" if float(value) > 0 else "neg" if float(value) < 0 else ""


def _table(headers: list[str], rows: list[list[str]], numeric_from: int = 1) -> str:
    head = "".join(
        f'<th class="{"r" if i >= numeric_from else ""}">{html.escape(h)}</th>' for i, h in enumerate(headers)
    )
    body = "".join(
        "<tr>"
        + "".join(f'<td class="{"r" if i >= numeric_from else ""}">{cell}</td>' for i, cell in enumerate(row))
        + "</tr>"
        for row in rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def render_statement(
    analytics: Any, settings: Settings, portfolio_id: int, portfolio_name: str, title: str
) -> str:
    """One self-contained HTML statement; every figure comes from the analytics."""
    from . import compliance, governance, lab, store

    summary = analytics.summary()
    risk = analytics.risk()
    base = analytics.portfolio.base_currency
    factsheet = lab.factsheet_report(
        analytics, portfolio_name, store.get_realized_pnl_summary(settings, portfolio_id)
    )
    kpis = factsheet["kpis"]
    checked = compliance.evaluate_all(
        governance.list_rules(settings, portfolio_id), compliance.exposure_from(analytics)
    )
    e = html.escape

    changes = [
        [e(label), f'<span class="{_tone(c["absolute"])}">{_signed(c["absolute"], base)}</span>', _pct(c["pct"], signed=True)]
        for label, c in (
            ("Today", summary["changes"]["day"]),
            ("This week", summary["changes"]["week"]),
            ("This month", summary["changes"]["month"]),
            ("This year", summary["changes"]["ytd"]),
            ("Since the start", summary["changes"]["all"]),
        )
    ]
    holdings = [
        [
            f"<b>{e(p.ticker)}</b> {e(p.name)}",
            _money(p.value_base, base),
            _pct(p.allocation_pct, 1),
            f'<span class="{_tone(p.unrealized_pnl)}">{_signed(p.unrealized_pnl, base)}</span>',
            _pct(p.unrealized_pnl_pct, 1, signed=True),
        ]
        for p in sorted(analytics.positions, key=lambda p: -p.value_base)
    ]
    sections = [
        f"<h2>Value</h2><p class=\"lead\">{_money(summary['total_value'], base)}</p>"
        + _table(["Period", "Change", "Return"], changes),
        "<h2>Performance and risk</h2>"
        + _table(
            ["Measure", "Value"],
            [
                ["Time-weighted return (since the start)", _pct(kpis["twr_pct"], signed=True)],
                ["Money-weighted return (annualised)", _pct(kpis["mwr_pct"], signed=True)],
                [f"Benchmark: {e(analytics.benchmark_name)}", _pct(kpis["benchmark_return_pct"], signed=True)],
                ["Active return", _pct(kpis["active_return_pct"], signed=True)],
                ["Volatility (annualised)", _pct(risk.get("volatility_annualized_pct"))],
                ["Maximum drawdown", _pct(kpis["max_drawdown_pct"])],
                ["One-day 95% VaR", _pct(kpis["var_95_pct"])],
                ["Sharpe ratio", f"{float(kpis['sharpe'] or 0):.2f}"],
            ],
        ),
        "<h2>Holdings</h2>" + _table(["Position", "Value", "Weight", "Unrealised", "Return"], holdings),
    ]

    report = summary.get("ledger")
    if report:
        sections.append(
            "<h2>Income and charges</h2>"
            + _table(
                ["Year", "Dividends", "Withheld", "Fees", "Taxes", "Realised"],
                [
                    [
                        e(row["year"]),
                        _money(row["dividends"]),
                        _money(row["withholding"]),
                        _money(row["fees"]),
                        _money(row["taxes"]),
                        _signed(row["realized"]),
                    ]
                    for row in report["by_year"]
                ]
                or [["—", "—", "—", "—", "—", "—"]],
            )
            + f"<p>Cash held: {_money(report['cash_value'], base)}.</p>"
        )
    sleeves = summary.get("sleeves") or {}
    if sleeves.get("has_sleeves"):
        sections.append(
            "<h2>Sleeves</h2>"
            + _table(
                ["Sleeve", "Value", "Weight", "Target", "Drift", "Return this year"],
                [
                    [
                        e(row["name"]),
                        _money(row["value"], base),
                        _pct(row["weight"], 1),
                        _pct(row["target_weight"], 1),
                        _pct(row["drift"], 1, signed=True),
                        _pct(row["return_ytd_pct"], 1, signed=True),
                    ]
                    for row in sleeves["sleeves"]
                ],
            )
        )
    status_label = {"pass": "Within every limit", "warning": "Close to a limit", "breach": "Limit breached", "unknown": "Not fully measurable"}
    sections.append(
        f"<h2>Compliance</h2><p class=\"status status--{checked['status']}\">"
        f"{e(status_label[checked['status']])}: {checked['checked']} rules checked, "
        f"{checked['breaches']} breached, {checked['warnings']} close.</p>"
        + (
            _table(
                ["Rule", "Figure", "Limit", "Status"],
                [
                    [
                        e(r["label"]),
                        _pct(r["actual"], 1) if r["unit"] == "weight" else (e(", ".join(r["offenders"])) or "none" if r["unit"] == "list" else f"{r['actual'] or 0:.0f}"),
                        _pct(r["limit"], 1) if r["unit"] == "weight" else ("not held" if r["unit"] == "list" else f"{r['limit'] or 0:.0f}"),
                        f'<span class="status status--{r["status"]}">{e(r["status"])}</span>',
                    ]
                    for r in checked["results"]
                ],
            )
            if checked["results"]
            else "<p>No rules are set for this portfolio.</p>"
        )
    )
    narrative = factsheet["narrative"]
    sections.append(
        "<h2>Commentary</h2>"
        + "".join(
            f"<p><b>{e(label)}.</b> {e(str(narrative[key]))}</p>"
            for key, label in (
                ("mandate_overview", "The portfolio"),
                ("performance_drivers", "Performance"),
                ("risk_and_concentration", "Risk and concentration"),
                ("stress_resilience", "Under stress"),
            )
            if narrative.get(key)
        )
    )

    generated = _local_now().strftime("%d %B %Y, %H:%M")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(portfolio_name)} — {e(title)}, {e(analytics.as_of)}</title>
<style>
  body {{ margin: 0; background: #f5f4ef; color: #111a16; font: 14px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; }}
  main {{ max-width: 880px; margin: 0 auto; padding: 40px 24px 64px; }}
  header {{ border-bottom: 2px solid #0f5e48; padding-bottom: 16px; margin-bottom: 8px; }}
  h1 {{ margin: 0; font: 600 32px Georgia, serif; }}
  h2 {{ margin: 32px 0 10px; font: 600 20px Georgia, serif; color: #0f5e48; }}
  .meta {{ color: #4a5852; }}
  .lead {{ margin: 0 0 12px; font: 600 30px Georgia, serif; }}
  table {{ width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e0d6; }}
  th, td {{ padding: 8px 12px; border-bottom: 1px solid #eceae3; text-align: left; }}
  th {{ color: #66746e; font-size: 12px; font-weight: 600; }}
  .r {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .pos {{ color: #15804e; }} .neg {{ color: #c0352b; }}
  .status--pass {{ color: #15804e; }} .status--warning, .status--unknown {{ color: #b86214; }} .status--breach {{ color: #c0352b; font-weight: 600; }}
  footer {{ margin-top: 40px; color: #66746e; font-size: 12px; }}
</style></head>
<body><main>
<header><h1>{e(portfolio_name)}</h1>
<p class="meta">{e(title)} · prices as of {e(analytics.as_of)} · in {e(base)} · measured against {e(analytics.benchmark_name)}</p></header>
{''.join(sections)}
<footer>Generated by ATLAS on {e(generated)}. Not investment advice. Market data from Yahoo Finance.</footer>
</main></body></html>
"""
