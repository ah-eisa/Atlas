# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

The API version is exposed at runtime (`/api/v1/health` → `version`), and the
frontend ships against it.

## [2.0.0] — 2026-10-21

The dashboard was rebuilt from a single-file analytics script into a proper
application: a versioned API, a persistence layer, a tested methodology, and
a six-view product surface. The data contract changed, so this is a breaking
change for anything that consumed the old routes.

### Added — backend

- **`backend/app/` package.** The service is now importable
  (`backend.app.api:app`) and split by concern: `api`, `portfolio`,
  `metrics`, `montecarlo`, `data`, `store`, `instruments`, `schemas`,
  `serialize`, `config`.
- **SQLite persistence** (`store.py`): positions, reporting currency, a
  revision counter, WAL mode, and a demo seed. CRUD is validated by strict
  Pydantic v2 schemas and surfaced as field-level `422` errors.
- **Time-weighted return engine** (`portfolio.py`): daily returns chained
  geometrically, positions activated on their acquisition date, external cash
  flows excluded from performance and reported separately.
- **Versioned API** under `/api/v1`: `health`, `bootstrap`, `portfolio/*`
  (summary, history, returns, risk, montecarlo, refresh, export), `positions`
  CRUD, `instruments/{ticker}`, `settings/base-currency`. The pre-1.0 routes
  remain as hidden aliases.
- **Benchmark analytics**: Jensen alpha, beta, tracking error, information
  ratio, up/down capture, correlation, and a benchmark comparison table.
- **Risk decomposition**: Euler risk contribution per position, Herfindahl
  concentration, effective holdings, top-five weight.
- **Tail risk**: CVaR (expected shortfall) at 95% and 99% alongside
  historical and parametric VaR.
- **Structured errors** everywhere: `{"detail": {"code", "message",
  "fields"?}}`, plus `X-Request-ID` and security headers on every response.
- **Optional API-key protection** (`PORTFOLIO_API_KEY`) with a constant-time
  comparison; the health probe and the static SPA stay public.
- **Atomic, versioned price cache** with batch fetch, per-symbol fallback,
  and a recorded `raw_last_dates` map.
- **Environment-driven configuration** (`PORTFOLIO_*`).
- **Regression fix:** the CORS middleware now wraps the API-key guard, so a
  rejected key returns a readable `401` instead of an opaque browser CORS
  error.
- **Docker image and compose file** serving the SPA and the API from one
  origin on one port.

### Added — frontend

- **Six hash-routed views** — Overview, Performance, Risk, Holdings,
  Projection, Data — instead of one long scrolling page.
- **New panels**: benchmark comparison, risk contribution, monthly returns
  heatmap, return distribution, projection assumptions, portfolio editor,
  and a data-provenance view.
- **Live position editor** (API mode): create, edit and delete positions with
  instrument lookup, client-side validation, and server field errors mapped
  back onto the inputs. Deletion requires an explicit confirmation.
- **Two-tier application chrome**: a fixed chrome row (brand, navigation,
  source badge, refresh) and a masthead that carries the portfolio identity
  and disappears when there is no data.
- **Empty, loading and error states** for every view, including an
  authorisation state that asks for the API key instead of reporting a
  connection failure.
- **Formatting layer** with pinned locale (`en-GB`), null-safe formatters,
  and tabular figures throughout.
- **Data source switching** (`?source=api|snapshot`) with a visible badge
  showing which one is live.

### Changed

- **Methodology.** The previous build projected two years of performance by
  holding *today's* quantities for the whole period. Returns are now
  time-weighted from the actual acquisition dates, and external cash flows
  are excluded from performance. The old figure was not reproducible; the
  new one is.
- **Configuration** moved from hard-coded constants to environment
  variables with validated defaults.
- **The committed `snapshot.json`** was regenerated from live market data and
  now carries the full analytics bundle.

### Fixed

- Prices are fetched for every holding including FX pairs, with per-symbol
  fallback instead of an all-or-nothing failure.
- The price cache is written atomically and carries a format version, so a
  schema change cannot be read back as valid data.
- Empty portfolios return a usable bootstrap payload instead of an error.
- The API base URL is derived from the page host, so opening the app on
  `127.0.0.1` no longer points it at `localhost`.
- Backgrounded tabs no longer display counters stuck at zero.
- The holdings grid can no longer overflow its container on narrow screens.

### Removed

- The old `backend/api.py`, `config.py`, `data.py`, `metrics.py`,
  `montecarlo.py`, `portfolio.py` and `serialize.py` top-level modules, and
  the frontend's `useAnalytics` hook. Their replacements live in the package
  above.

## [1.0.0] — upstream baseline

The original public template: a FastAPI service with a JSON position file, a
React dashboard built around allocation, performance, drawdown, Sharpe,
Sortino, VaR, beta, a correlation matrix and a Monte Carlo projection, and a
committed `snapshot.json` so the dashboard renders with no backend running.
