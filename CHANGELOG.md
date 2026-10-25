# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

The API version is exposed at runtime (`/api/v1/health` → `version`), and the
frontend ships against it.

## [Unreleased]

### Added — the mandate and oversight (schema version 8)

- **Benchmark policy** per portfolio: a blend of indices or funds (weights
  adding up to 100%, funds measured with dividends reinvested), rebalanced
  daily or monthly. It replaces the configured benchmark for that portfolio
  in beta, alpha, tracking error, the chart and the factsheet.
- **Model portfolios**, shared by every portfolio: a portfolio that follows
  one is measured against its weights, including what the model holds and
  the portfolio does not.
- **Sleeves**: named parts of a portfolio with a target share; each sleeve's
  value, weight, drift and holdings-based return (`summary.sleeves`).
- **Compliance**: fifteen kinds of limit, each within / close / past (hard or
  soft), with the positions responsible; and a **pre-trade check** in the
  trade window that says which limits an order would breach.
- **Audit trail**: every change recorded in its own transaction with the
  actor of the request; append-only (triggers) and SHA-256 hash-chained, with
  a verification of the chain.
- **Scheduled reports**: daily, weekly or monthly HTML statements (value,
  performance and risk, holdings, income and charges, sleeves, compliance,
  commentary), or one on demand; every run recorded.
- Two views under **Governance**: Mandate and Oversight.

### Fixed

- A page served by the API itself (the Docker image, or `uvicorn` on any
  port) now talks to the API at its own origin, instead of always port 8000.
- The portfolio export now exports the selected portfolio, not always the
  first.
- A looked-up price is entered to the cent instead of with float noise.

### Added — the book of record (schema version 7)

- **Every change is a ledger entry**, and positions are rebuilt by replaying
  them in date order: trades with a **fee** (part of a purchase's cost, off a
  sale's proceeds) and a **tax**; **dividends** with the tax withheld;
  standalone **fees** and **taxes**; **splits** (and reverse splits),
  **symbol changes and share mergers**, **spin-offs** with the cost share
  they take, **returns of capital**, and **currency conversions**. A hand
  edit of a position is recorded as an adjustment. Backdated entries and
  deletions stay consistent; an entry that would make the ledger impossible
  is refused (422, or 409 on deletion). `GET/POST/DELETE /api/v1/ledger-events`.
- **Cash per currency.** Sale proceeds and dividends stay in the portfolio as
  cash until spent or withdrawn; purchases are paid from it, and what it
  cannot pay for is money the owner added, at its cost. Foreign cash is
  revalued daily, so currency moves on it are part of the return. Cash is
  shown with the holdings and in the allocation, and added to the Monte
  Carlo outcomes.
- **Units sold are part of the history** until the day they were sold, and
  history before a split is restated in today's units.
- **Dividends from the market data**: prices are now split-adjusted only, and
  each dividend is credited as cash at the units held on its ex-date; one
  you record replaces it. A price cache from before this version is still
  read when the provider is unreachable, with dividends taken as already in
  the price.
- **The Ledger view** (formerly Trades): realised result, net income, fees and
  taxes, cash; income and charges by year; every entry, filterable by kind,
  with a window to record income, charges, corporate actions and
  conversions. The trade window takes a fee and a tax.
- `summary.ledger` and `holdings.cash` in the payload; 24 new tests that pin
  each figure.

### Changed — the "Sovereign" design

- New palette in both themes: alabaster and emerald for light, obsidian for
  dark, with gold for forward-looking figures. Cormorant Garamond for
  headlines and lead figures, Plus Jakarta Sans for the interface, JetBrains
  Mono for every figure.
- The toolbar is pinned frosted glass with a Light / Dark pill. On the
  overview the value leads a statement card (invested capital, unrealised
  P&L, profitable positions, projection median) beside four cards for the
  changes that matter, each with the deposits it is net of.
- Pill buttons, an emerald primary action, rounded cards on a softly lit page.

### Added

- **Reporting currency in the toolbar.** In live mode the currency every
  figure is reported in can be switched from the toolbar; the analytics are
  rebuilt in the new currency.
- **Holding details.** A click (or Enter) on a holding opens it up close:
  value, unrealised P&L and weight, its ninety-session price, cost, quantity,
  the price and FX split, and a what-if slider that shows the weight it
  would carry at another size. Trade and Edit open from there.
- **Asset-class filters** on the holdings grid, and the instrument, name and
  class in one cell beside its ninety-session trend.
- **Performance chart:** 3M and 6M ranges, a soft wash under the portfolio's
  line (and the drawdown), and the gap to the benchmark in the legend.

### Fixed

- A page left open across a new build no longer goes blank when it opens a
  view: it reloads once to pick up the new files.

## [2.3.0] — 2026-10-24

The trade ledger, fixed income, macro and filings, options and the portfolio
lab, merged into one product: a FIFO ledger whose figures hold up, every
synthetic number labelled, one design across eleven views, and a container
image that builds again. Schema version 6 (tax lots) is applied on start.

### Fixed — container image

- **The image builds again.** The frontend stage copied `frontend/` and
  `snapshot.json` into one directory, but the Vite build reads the snapshot
  at `../snapshot.json`, so the snapshot plugin failed and CI was red. The
  stage now mirrors the repository layout.
- **The image ships the bundled bond and macro datasets.** `.dockerignore`
  excluded all of `backend/data`, which would have served an empty yield
  curve. CI now checks that the container serves the curve and the page.

### Changed — documentation

- The README describes all eleven views, the ledger, the design and the
  current limitations, and points to `ah-eisa/Atlas`. The development
  report has a 2.3 section.

### Changed — "Statement" design

- **A navigation rail on the left** replaces the top navigation bar. It
  holds the wordmark, the portfolio switcher, the grouped views with an
  icon each, and the data source. It collapses to icons (labels then show
  as tooltips), remembers the choice, and opens and closes with Ctrl+\.
  On a phone it is a drawer that slides in over the page.
- **Evergreen and Newsreader.** Light is now the base palette, with a dark
  theme on the same roles. The portfolio's value, panel titles and headline
  figures are set in Newsreader; the interface in Instrument Sans. IBM
  Plex Sans is no longer bundled.
- **The overview opens with a sentence**: what the portfolio is worth
  against what was paid, how many holdings are in profit, and the median of
  next year's simulated outcomes, beside a card of four colour-keyed
  changes.
- **Content sits on cards** with space between them, instead of a
  hairline grid.
- **Each asset class has one colour everywhere**: a mark beside every
  ticker, the holding's weight bar, and its slice of the allocation donut,
  which previously coloured slices by rank.
- Weight bars grow in on load; the current view's highlight slides along
  the rail.
- Charts drawn with Lightweight Charts, and every panel coloured from the
  chart theme, now repaint on a live theme switch; they previously kept the
  old theme's gridlines and series colours until something else
  re-rendered them.

### Changed — visual design

- **A new palette.** Ink-navy surfaces with warm off-white text and a single
  brass accent, used only for where you are and the primary action. Gains
  and losses are green and coral and warnings orange, so the accent is never
  read as a signal. Glows and the background gradients are gone. The light
  theme uses the same roles on cool paper.
- **Figures in IBM Plex Sans with tabular numerals** instead of a monospace
  face; monospace is kept for code and raw CSV only.
- **Sentence-case labels throughout**, on a larger type scale: panel
  titles, figure labels, column headers and range toggles no longer shout.
- **The portfolio's value leads the overview** at display size, with its
  recent path beside it; on every other view it shrinks to one line so the
  view's content starts near the top.
- **Chart colours validated for colour-vision deficiency** on both
  surfaces, in a fixed order that keeps green for gains only. The bonds,
  macro and options charts, which hard-coded another design system's
  colours, now use the same palette.
- **The bonds, macro and filings, options and lab views** used class names
  no stylesheet defined, so their figures stacked one per row and their
  headers fell back to browser defaults. They now share the rest of the
  product's layout, with plain-language titles and tabs (the lab's tabs are
  no longer numbered as if they were steps).
- Holdings rows use a quiet Trade button, so the one accent on the page is
  the primary action.

### Changed — navigation and windows

- **The views are grouped**: Portfolio (overview, performance, risk, lab,
  projection), Book (holdings, trades), Markets (bonds, macro and filings,
  options) and Sources (data). An indicator slides to the current view, the
  bar scrolls the current view into sight on narrow screens, and Left/Right
  move between views inside it. `[` and `]` step to the previous or next
  view from anywhere outside a field.
- **One toolbar row.** Watchlist, Import and Add position move into a More
  menu below 1240px instead of disappearing on small screens; on phones the
  data-source switch and refresh join them, so the row fits at 360px.
- **Every window is built from one `Dialog`.** Escape closes the topmost
  window, Tab stays inside it, focus moves into it on open and returns to
  the button that opened it, and the page behind does not scroll. Forms no
  longer close on a stray click outside. On a phone a window is a bottom
  sheet with full-width actions.
- **The trade, position, portfolio, import and watchlist windows were
  rewritten in plain language**, with sentence-case labels, errors that say
  what to do, and a note that the gain shown before a sale is estimated at
  the average cost while the ledger records the FIFO figure. The import
  window takes a dropped file, and the watchlist uses real, keyboard-operable
  tabs.
- **The command palette** is a proper combobox: the highlighted result is
  announced and kept in view while moving with the arrow keys.
- Buttons are sentence case at a readable size, without the hover lift and
  glow; the primary button is a solid accent rather than a gradient.
- Data tables (`.table`) now have a base style: padding, sticky headers,
  right-aligned figures.
- The overview's nine headline figures sit in a 9- or 3-column grid, so no
  figure is left alone on a row.
- The market ticker treats a response without a `source` field as live, so
  it does not mislabel quotes from an older API.

### Fixed — trade ledger and data sources

- **Sales are matched FIFO.** Each purchase is now its own lot (schema
  version 6), and a sale consumes the oldest lots held on its date. Realized
  P&L was previously measured against the average cost, which misstated it
  whenever lots were bought at different prices.
- **Each lot enters the history on its own date.** Buying more of a held
  position no longer credits the new units with returns from before they
  were bought.
- **Deleting a transaction reverses it.** Deleting a sale returns its units
  to the lots it took them from, and reopens a position it had closed.
  Deleting a purchase removes its lot, and is refused with
  `409 transaction_conflict` while a later sale has used those units. A
  position edited by hand since the order is kept as edited.
- **CSV imports replay trades in date order**, buys before sells on the
  same day, so newest-first broker statements no longer drop their sales.
- **Watchlist alerts only fire on current prices.** Prices come from the
  portfolio, then a live lookup, then the static reference table, and each
  item reports its `price_source`. Reference prices are shown but never
  trigger, and an unknown ticker is unpriced rather than priced at 100.
- **Synthetic data is labelled.** The option chain and the market ticker
  report `source: "live" | "sample"`, and the UI says when it is showing
  samples. Greeks on a live chain are priced from each contract's own
  implied volatility instead of fixed placeholders, and live chains are
  cached for five minutes rather than until restart.
- **The attribution report's reference return covers the selected window**
  instead of the whole history.
- `scipy` and `pyarrow` are declared in `backend/requirements.txt`, and the
  fixed income loader logs files it cannot read.

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
