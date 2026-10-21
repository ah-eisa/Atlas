# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

The API version is exposed at runtime (`/api/v1/health` → `version`), and the
frontend ships against it.

## [Unreleased]

### Added — observability

- **`GET /api/v1/metrics`** reports process uptime, request totals by status
  and method, 5xx errors, nearest-rank latency percentiles (p50/p95/p99/max
  over the last 2,048 API requests) and analytics-cache hits, misses, builds
  and invalidations. It is `Cache-Control: no-store`, protected by the API key
  when one is configured, and deliberately stores no path, query, header or
  portfolio identifier, so it cannot leak what it never records.
- **The cache counters make rebuilds visible.** A miss/build rate that keeps
  climbing is the signature of a cache key that changes too often or a price
  refresh loop, which the latency percentiles alone would not explain.

### Changed — frontend

- **The six views are code-split.** Each view is a module loaded on demand
  with `React.lazy`, so the application shell, the masthead and the KPI band
  paint without waiting for a view's panels or the charting libraries. The
  entry bundle fell from 346.6 kB to 206.8 kB (103.2 kB to 65.2 kB gzipped);
  ECharts and Lightweight Charts are now separate demand chunks, and Data and
  Holdings pull neither. Route changes run in `startTransition`, so the
  current view stays on screen while the next chunk arrives instead of
  flashing a placeholder.
- **The view modules live in `frontend/src/views/`.** `App.tsx` keeps the
  shell, the loading/empty/error states and the route switch; each view owns
  its panels and its props. This is what makes the split possible without a
  second routing layer.

## [2.2.0] — 2026-10-21

Everything below was built on top of 2.1.0: the analytics were made
defensible before more surface was added.

### Added — methodology

- **Total-return benchmark.** The portfolio's prices are dividend-adjusted,
  but the default benchmark was the price-only `^GSPC`, which biased alpha,
  tracking error and the information ratio downwards by roughly the dividend
  yield. The default is now `^SP500TR`, and the benchmark's dividend treatment
  is an explicit setting (`PORTFOLIO_BENCHMARK_INCLUDES_DIVIDENDS`) rather
  than an assumption. A price index can still be selected, and the UI says
  which one is in use.
- **FX decomposition.** Unrealised P&L is split into the instrument's price
  effect and the currency effect, with the cost basis converted at the FX rate
  of the acquisition date. Positions that predate the price history are
  reported as unattributed instead of being smeared across the rest.
- **Recorded cash flows.** Contributions and withdrawals are now stored with a
  date, an amount and a note instead of being inferred from value jumps. When
  the ledger has entries they are authoritative; when it does not, the
  estimated source is still published and labelled.
- **Money-weighted return.** XIRR over the recorded flows and the terminal
  value is reported beside the time-weighted return, plus the source of the
  flows behind it. The two measures answer different questions and the UI does
  not conflate them.
- **Active-return attribution.** The active return is attributed to positions
  and grouped by region and asset class, with the residual (compounding and
  cash flows) shown rather than hidden.
- **Historical replay.** The current weights are applied to a chosen past
  window, with return, volatility, drawdown and best/worst day, so the
  portfolio can be stress-tested against a period it did not live through.
- **Target weights and drift.** Positions carry an optional target weight;
  the summary reports current weight, drift, the trade that would close it,
  turnover, and the residual when targets do not sum to one.
- **Benchmark comparison and rebalance preview.** Any symbol can be compared
  with the portfolio on its own sample (alpha, beta, tracking error,
  information ratio, capture, correlation), and a proposed set of weights can
  be previewed without changing the stored portfolio.

### Added — data and storage

- **Schema versioning and multiple portfolios.** The SQLite schema carries a
  `user_version` and migrates forward; portfolios have names and their own
  reporting currency, selected per request with `X-Portfolio-Id`. The default
  portfolio cannot be deleted.
- **Last-known-price fallback.** When the provider fails, the analytics are
  built from the newest cached prices and the payload says the prices are
  stale, instead of failing the whole request.

### Added — platform

- **API.** `GET/POST /api/v1/portfolios`, `DELETE /api/v1/portfolios/{id}`,
  `GET/POST/DELETE /api/v1/cash-flows`, `GET /api/v1/portfolio/benchmark`,
  `GET /api/v1/portfolio/replay`, `POST /api/v1/portfolio/what-if`. Export now
  carries cash flows as well as positions.
- **The payload contract is pinned.** `backend/export_schema.py` generates a
  JSON Schema from the Pydantic models; `backend/tests/test_contract.py`
  validates the committed `snapshot.json` against it, and CI regenerates the
  schema and fails if the committed copy differs.
- **Test harnesses.** Vitest covers the formatters, the hash router and the
  snapshot normaliser. Playwright runs a seven-scenario smoke suite on a
  desktop and a phone viewport, against the production bundle: every view
  renders, the figures are real, counters settle, the theme switch repaints
  and persists, nothing overflows sideways, and the holdings grid scrolls.
- **CI** gained a browser job that uploads the Playwright report on failure.

### Fixed

- **Charts no longer throw on unmount.** Navigating between views could
  surface `Object is disposed` from a chart instance whose resize or
  animation callback landed after teardown. The wrappers now own their
  observers, mark the instance disposed before removing it, and stop the
  ECharts animation loop before disposal.
- **The counters no longer announce twice.** The animated copy is hidden from
  assistive technology and the reserved final figure — announced once, at its
  true value — is the accessible one.
- **The Data view is wrapped in the shared `<main>` landmark**, so every view
  has the same document structure.

## [2.1.0] — 2026-10-21

### Added — frontend

- **A complete light palette** alongside the dark one, switched from the
  header. The light theme is a paper-white instrument panel with its own
  surfaces, hairlines, categorical ramp, sequential heat ramp and monthly
  return heat scale - not an inversion of the dark one. The first visit
  follows the operating system's `prefers-color-scheme`; an explicit choice
  is remembered and survives a reload.
- **No flash on load**: the theme is applied by an inline script before the
  first paint, and `color-scheme` is set so native controls, scrollbars and
  date pickers match the palette.
- **The charts follow the theme.** The ECharts and Lightweight Charts
  palettes are read from the same CSS custom properties as the page, so a
  palette switch repaints the plot furniture and the series, not just the
  chrome.

### Fixed

- **Contrast.** The context lines under the headline figures, the panel
  notes, the footer and several secondary labels were painted in the
  "disabled" colour, which was around 2:1 against the surface. They now use
  the tertiary text colour, and every text role clears WCAG AA (4.5:1) in
  both themes - the tightest is 4.56:1 in the light palette and 5.01:1 in
  the dark one.
- **Correlation heatmap labels** now pick their text colour from the actual
  cell fill, by contrast, instead of a fixed threshold that only worked in
  one palette.

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
