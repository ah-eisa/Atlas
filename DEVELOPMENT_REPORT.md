# Development Report — ATLAS 2.3

An engineering record of the work that turned the original portfolio-dashboard
template into a standalone investment analytics application: what was wrong,
what changed, how it was verified, and what is still missing.

This edition covers 2.3. The 2.2 work made the analytics defensible; 2.3
merged the trade ledger, fixed income, macro and filings, options and the
portfolio lab into one product, then spent most of its effort making the
ledger's numbers correct, labelling every synthetic figure, and giving the
eleven views one design. The 2.2 record follows unchanged, from section 1.

---

## 2.3 at a glance

### What was built

| Area | Change |
|---|---|
| **Trade ledger** | Every purchase is its own lot (schema v6). A sale consumes the oldest lots held on its date, so realised P&L is measured against the cost of the units sold instead of the average cost. Deleting a sale returns its units, and reopens a position the sale had closed; deleting a purchase that a later sale used is refused (`409 transaction_conflict`). A position edited by hand becomes a single new lot. |
| **History** | Each open lot enters the position history on its own date, so units bought later are not credited with earlier returns. |
| **Import** | CSV and broker-statement trades are replayed in date order, buys before sells on the same day, so newest-first statements no longer drop their sales. |
| **Honest data** | Watchlist alerts fire only on portfolio or live prices; static reference prices are labelled and never trigger. Option chains and the market ticker report `live` or `sample`. Live Greeks come from each contract's implied volatility instead of placeholders. Prices are shown in the currency they are quoted in, with the converted price beneath. |
| **Lab** | The attribution report's reference return covers the selected window. |
| **Merged views** | Bonds, macro and filings, options and the lab now share the product's layout and palette; they had relied on class names no stylesheet defined. |
| **Design** | "Statement": a collapsible navigation rail (drawer on phones), cards on a quiet page, Newsreader and Instrument Sans, an evergreen accent, one colour per asset class, light and dark themes. Every window is one accessible dialog (Escape, focus trap and return, scroll lock). |
| **Operations** | `scipy` and `pyarrow` declared; the fixed income loader logs files it cannot read; the dashboard page is sent `no-cache`; the Docker image builds again and ships the bundled datasets. |

### Verification

| Check | Result |
|---|---|
| Backend tests | 216 pass (21 new: FIFO lots, reversible deletions, backdated sales, lot-dated history, CSV ordering, data-source labelling, windowed attribution, cache header) |
| Frontend unit tests | 19 pass |
| Browser smoke suite | 14 scenarios on desktop and phone, all pass (new: Escape and focus return, grouped navigation and `[` `]`, single copy of an animated figure) |
| Payload contract | Unchanged schema; CI comparison passes |
| Lint | No new warnings (5 pre-existing `exhaustive-deps` warnings remain) |
| Container | The build failure was reproduced outside Docker (the Vite snapshot plugin could not find `../snapshot.json` in the old stage layout) and fixed; CI now also checks the container serves the yield curve |

### Remaining technical debt

- ~~The ledger records buys and sells only~~ — done after 2.3: dividends,
  fees, taxes, splits, symbol changes, spin-offs, returns of capital and FX
  conversions are ledger entries, with cash per currency (see CHANGELOG,
  Unreleased).
- ~~Units already sold are not represented in past position values~~ — done
  after 2.3.
- Corporate actions are entered by hand; the provider's action feed is not
  read. Taxes are recorded, not computed.
- The bond and macro datasets live on the data volume, so an existing volume
  keeps the copy it was seeded with.
- Five `react-hooks/exhaustive-deps` lint warnings in the merged views.
- The ECharts chunk is above Vite's 500 kB warning.

### Next priorities

1. **Portfolio accounting audit**: FIFO edge cases, corporate actions,
   dividends, fees, taxes, splits and FX cash flows, each with tests that pin
   the expected figures.
2. **Institutional portfolio layer**: benchmark policies, sleeves and model
   portfolios, compliance rules, an audit trail, scheduled reporting.
3. **Multi-user, authentication and permissions**, only once the product is
   used by more than one person.

---

# The 2.2 record

## 1. Starting point

The repository was a public template: a FastAPI service with a JSON position
file, a React dashboard, and a committed `snapshot.json` so the dashboard
renders with no backend running. The bones were good — a real backend, a real
frontend, 87 passing tests, and metrics that were actually computed rather
than faked. But the analytics were not correct, and the structure did not
support the feature set an institutional tool needs.

### Problems found in the original

| # | Area | Finding | Impact |
|---|---|---|---|
| 1 | **Methodology** | Performance was computed by holding *today's* quantities across a two-year history, ignoring acquisition dates | The headline return was fabricated; a position bought last month was credited with two years of history |
| 2 | **Methodology** | Contributions and withdrawals were not separated from performance | Deposits read as gains, or as losses |
| 3 | **Data** | One bad symbol failed the whole fetch; no per-symbol fallback | A single delisted ticker took the app down |
| 4 | **Data** | The price cache had no format version and was written non-atomically | A partial write or a schema change could be read back as valid data |
| 5 | **Structure** | Six flat modules at `backend/` root; the service was not importable as a package | No clean seam between HTTP, computation, storage and configuration |
| 6 | **Persistence** | Positions lived in a JSON file edited by a script | No editing in the app, no validation, no concurrency safety |
| 7 | **API** | Unversioned routes, ad-hoc error shapes, no request ids, no security headers | Every client had to guess; failures were hard to diagnose |
| 8 | **Security** | No API-key support, no CORS policy, no CSP | Nothing to deploy outside localhost, and no protection for a shared host |
| 9 | **Frontend** | One long page, no routing, no empty/loading/error states, no data-source switch | Nothing to deploy outside localhost, and no protection for a shared host |
| 10 | **Frontend** | The hard-coded API base URL (`localhost`) did not match a `127.0.0.1` origin | Live mode failed for anyone opening the app by its numeric address |
| 11 | **Analytics** | No benchmark-relative statistics, no risk decomposition, no tail-risk measure, no concentration | The risk section could not answer "which position is doing the damage?" |
| 12 | **Delivery** | No container, no deployment path, outdated README and API docs | Onboarding cost far higher than the project deserved |

---

## 2. What was built

### 2.1 Backend: from script to service

```
backend/app/
├── api.py          HTTP surface: routes, middleware, error contract
├── portfolio.py    TWR engine, payload assembly
├── metrics.py      return, risk, benchmark and concentration maths
├── montecarlo.py   path simulation
├── data.py         yfinance fetch, FX, atomic versioned cache
├── store.py        SQLite persistence
├── instruments.py  ticker metadata
├── schemas.py      strict Pydantic v2 models
├── serialize.py    JSON-safe rounding
└── config.py       environment-driven settings
```

Key decisions:

- **The service is a package.** `backend.app.api:app` is importable, so tests
  can drive it directly and the container has one obvious entry point.
- **SQLite for positions.** WAL mode, a revision counter, and a schema
  version. The revision counter is what makes the analytics cache correct:
  the model is rebuilt when positions or the reporting currency change, not
  on every request.
- **Analytics are cached, prices are not.** Building the model downloads
  prices and runs 10,000 Monte Carlo paths; doing that per request would be
  unusable. A `force`/`refresh_prices` pair covers the two cases where a
  rebuild is wanted.
- **Errors are a contract.** Every failure is
  `{"detail": {"code", "message", "fields"?}}`. The UI can therefore show a
  field-level message next to the offending input instead of a generic
  failure banner.
- **CORS is outermost.** Middleware runs in reverse registration order in
  Starlette, so the CORS layer is registered last. Before this fix the
  API-key guard answered outside the CORS layer and the browser received an
  opaque CORS failure instead of the `401` the server had sent. A regression
  test now pins that behaviour.

### 2.2 The return methodology

This is the part that decides whether the product is worth anything.

**Time-weighted return, with activation dates.** Daily returns are computed
from portfolio market value and chained geometrically. A position is
activated on its acquisition date; before that date it contributes nothing,
neither to the return nor to the risk.

**External cash flows excluded.** Contributions and withdrawals do not enter
the return series. They are reported separately (`flows` in the history
payload, and the net invested figure printed under the Performance panel), so
the absolute and percentage figures can be reconciled by hand.

**Benchmark statistics on the common sample.** Alpha and beta are estimated
from daily excess returns; tracking error is the annualised standard
deviation of active returns; the information ratio is active return over
tracking error; capture ratios compare up-day and down-day behaviour.

**Euler risk contribution.** The covariance matrix is decomposed so each
position's share of portfolio variance includes the correlation effect. The
ratio of risk share to capital weight is the figure that finds the position
quietly dominating the book.

**Tail risk.** Historical and parametric VaR at 95% and 99%, with CVaR
(expected shortfall beyond the threshold) at both levels.

**Stated conventions.** Every figure carries its convention — annualised,
geometric, over what window, against what risk-free rate — in the payload,
in the API reference, and on screen.

### 2.3 Frontend: from a page to a product

Six hash-routed views, so the app answers six distinct questions instead of
one long scroll:

| View | Contents |
|---|---|
| Overview | KPI band, growth/drawdown chart, allocation, benchmark panel, risk contribution, holdings grid |
| Performance | Growth / return / drawdown views, period table, monthly heatmap, return distribution |
| Risk | Benchmark panel, risk contribution, full risk table with warnings, correlation matrix |
| Holdings | Holdings grid, allocation, and the live position editor (API mode) |
| Projection | Monte Carlo bands, outcome distribution, and the model assumptions |
| Data | Provenance, source switch, refresh, API key, methodology statement |

Design decisions:

- **The design system was extended, not replaced.** The original dark
  institutional look — hairline grids, tabular figures, one accent colour —
  was the strongest thing about the original code, so it was kept and
  systematised: tokens for spacing, colour and heat scales; one button and
  notice vocabulary; responsive grids that collapse rather than overflow.
- **Two complete palettes.** The dashboard is read at 3am on a trading floor
  and at midday in an office, so a light theme was added as a real second
  palette — its own surfaces, categorical ramp, sequential heat ramp and
  monthly return heat scale — rather than as an inversion of the dark one.
  Both live in `tokens.css`; the charting libraries read the same tokens, so
  a palette switch repaints the plots as well as the page. The theme follows
  `prefers-color-scheme` until the user chooses one, and is applied before
  the first paint so the page never flashes.
- **Motion is used once, on load.** Numbers count into place over one second
  and stop. `prefers-reduced-motion` disables it, and a backgrounded tab
  shows the final value rather than a frozen zero.
- **The editor is explicit about what it stores.** Quantity and cost basis
  per unit, plus an acquisition date, because those are the three fields that
  silently corrupt a portfolio valuation.
- **Failure is a state, not a crash.** Loading, empty portfolio, analytics
  unavailable, authorisation required, and connection failure are all
  designed states with their own copy and their own next action.
- **Contrast was audited, not assumed.** Several secondary labels (the
  context lines under the headline figures, the panel notes, the footer) were
  painted in the "disabled" colour at roughly 2:1. Every text role now
  clears WCAG AA in both palettes — 4.56:1 at the tightest in light, 5.01:1
  in dark.

### 2.4 Delivery

- `Dockerfile` — multi-stage build; the SPA is compiled in stage one and
  copied into the runtime image, so the API and the dashboard share an
  origin and there is no CORS to configure.
- `docker-compose.yml` — the whole stack on `localhost:8080`, with volumes
  for the database and the price cache.
- `README.md` and `API.md` rewritten against the code that actually exists.
- `CHANGELOG.md` documents the breaking change in the data contract.

### 2.5 Version 2.2: from plausible to defensible

The 2.0 build answered the obvious questions. Reviewing it against the
original audit found four places where an answer was plausible but not
defensible, and each one was fixed before any new surface was added.

| # | Problem | Why it mattered | What changed |
|---|---|---|---|
| 1 | The benchmark was `^GSPC`, a price-only index, while holdings were fetched with `auto_adjust=True` | Alpha, tracking error, information ratio and capture were all biased downwards by roughly the dividend yield (1.3–1.8%/yr for the S&P 500) | Default is `^SP500TR`; dividend treatment is an explicit setting published in the payload and shown in the UI |
| 2 | Cash flows were *inferred* from value jumps | An inferred flow is indistinguishable from a real one, and the money-weighted return would inherit the guess | Contributions and withdrawals are recorded with a date, amount and note; the payload says whether the flows are `ledger` or `estimated` |
| 3 | Currency and asset returns were reported as one P&L number | With 54.5% USD exposure, a euro investor could not tell whether the gain was the asset or the dollar | P&L is decomposed into price and FX effects, with the cost basis converted at the FX rate of the acquisition date, and an explicit `unattributed` remainder |
| 4 | There was no way to ask "what if" | The only view of risk was the book as it happened to be | Replay, target weights with drift, active-return attribution, benchmark comparison and a rebalance preview, all read-only |

Three further decisions followed from those:

- **The residual is reported, not plugged.** Attribution is an arithmetic
  decomposition of daily active returns; compounding means the parts do not
  sum exactly to the compounded active return. The difference is a named
  field, not a hidden adjustment.
- **Scenarios say what they are.** A replay applies *today's* weights to a
  past window; it is not a reconstruction of holdings. The panel and the API
  reference both state this, because a stress test presented as history is a
  fabricated fact.
- **The default portfolio is special.** It can be renamed but not deleted:
  the service always needs somewhere to put a position. Multi-portfolio
  support therefore did not become multi-tenant support.

The second half of 2.2 was spent making regressions expensive:

- the backend payload is generated as a JSON Schema and the committed
  `snapshot.json` is validated against it;
- CI regenerates the schema and fails on drift, so a payload change cannot
  silently desynchronise the frontend;
- Vitest covers the pure frontend logic (formatting, the hash router, the
  snapshot normaliser);
- Playwright runs the built product in Chromium at desktop and phone widths,
  and the suite found three real defects: a double-announced counter, a
  missing `<main>` landmark on the Data view, and `Object is disposed` thrown
  by charts whose resize or animation callback landed after teardown.

### 2.6 After 2.2 (unreleased)

Two pieces of delivery work landed after the 2.2 release and are recorded here
because they change how the product is operated:

- **The six views are code-split.** Each view is a `React.lazy` module under
  `src/views/`; route changes run in `startTransition`, so the current view
  stays on screen while the next chunk loads. The entry bundle fell from
  346.6 kB to 206.8 kB (103.2 kB to 65.2 kB gzipped), and ECharts and
  Lightweight Charts became demand chunks. Data and Holdings fetch neither.
- **The process is observable.** `GET /api/v1/metrics` reports request counts
  by status and method, 5xx errors, nearest-rank latency percentiles over the
  last 2,048 API requests, uptime and analytics-cache decisions. The registry
  stores no path, query, header or portfolio identifier, so the endpoint
  cannot leak request data even though it is protected by the API key.

---

## 3. Verification

### 3.1 Backend

```
174 passed, 1 warning   (Starlette's httpx deprecation notice)
```

The suite is hermetic: a synthetic market with a fixed seed, a temporary
SQLite database per test, and no network access. It covers:

- metric correctness (drawdown, VaR/CVaR, concentration, capture ratios,
  XIRR and bisection failure modes, FX decomposition);
- the methodology (TWR chaining, activation dates, recorded and estimated
  cash flows, money-weighted return);
- the store (CRUD, revision counter, base currency, demo seeding, schema
  version, portfolio isolation);
- the HTTP contract (bootstrap, CRUD, validation, duplicate tickers, empty
  portfolios, cash flows, portfolios, exports, API-key protection, CORS on
  rejected keys, security headers, structured 404s, the requested
  portfolio's currency);
- the scenario routes (replay windows, what-if trades, benchmark comparison);
- the metrics registry (bounded window, nearest-rank percentiles, status and
  cache counters) and the metrics endpoint's contract, including that it
  requires the API key and returns no request identifiers;
- the payload contract (`snapshot.json` against a generated JSON Schema).

### 3.2 Frontend

- `npm run lint` (oxlint) — clean.
- `npm run test` (Vitest) — 19 tests across the formatters, the hash router
  and the snapshot normaliser.
- `npm run build` (`tsc -b` + Vite) — clean; the build reads the committed
  `snapshot.json`, so a malformed snapshot fails the build.
- `npm run test:e2e` (Playwright) — 8 scenarios × 2 viewports, against the
  production bundle: mount, every view, chart sizing, real figures, counter
  settling, theme repaint and persistence, no horizontal overflow, grid
  scrolling.
- `npm audit --omit=dev` — no vulnerabilities in production dependencies.

### 3.3 Manual verification against a running stack

| Scenario | Result |
|---|---|
| Snapshot mode, all six views | Pass |
| Live API mode, bootstrap | Pass |
| Instrument lookup (`NVDA`, `PFE`) | Pass — live metadata and last price |
| Duplicate ticker | Rejected with `409`, message shown in the form |
| Create a position through the UI | Pass — count 12 → 13, totals rebuilt |
| Edit a position through the UI | Pass — quantity change reflected in the model |
| Delete a position through the UI | Pass — two-step confirmation, totals restored exactly |
| Reporting currency EUR → USD → EUR | Pass — 84,685.65 EUR → 94,981.66 USD → 84,685.65 EUR |
| Export JSON and CSV | Pass |
| Refresh (bypasses the price cache) | Pass — `revision` incremented, `as_of` unchanged within the same session |
| Invalid body (`quantity: -1`) | `422` with a field-level message |
| Unknown route | Structured `404` |
| API key required, no key supplied | `401` with a readable body, UI asks for the key |
| API key supplied | Pass — portfolio loads, editor enabled |
| Empty portfolio | `200` bootstrap with `analytics: null`; UI shows the empty state and the editor |
| Backend unreachable | Connection-error state with retry and source-switch actions |
| Browser console during all of the above | No errors or warnings |
| Light and dark palettes, all six views | Pass — the light palette is a second complete design, not an inversion |
| Theme persistence across a reload | Pass — applied before the first paint, no flash |
| Text contrast in both palettes | Pass — every role clears WCAG AA (4.56:1 light, 5.01:1 dark) |

The 2.2 analytics — FX attribution, money-weighted return, recorded flows,
replay, drift, attribution and benchmark comparison — are covered by the
backend and contract suites, and the browser suite loads every view that
hosts them. The manual pass above was not repeated for each new panel; when a
check is automated it is listed in 3.1/3.2 instead of here.

---

## 4. Security review

| Area | Finding | Action |
|---|---|---|
| Authentication | None | Optional `X-API-Key` with constant-time comparison; liveness and static assets stay public |
| Authorisation | Single-user by design | Documented; not a multi-user system |
| CORS | Permissive by default in the original | Restricted to known local origins plus a localhost/127.0.0.1 regex, configurable |
| Error leakage | Stack traces possible | Structured error envelope; internal details logged, not returned |
| Request tracing | None | `X-Request-ID` on every response, echoed from the client when supplied |
| Security headers | None | `nosniff`, restrictive CSP, `Referrer-Policy: no-referrer` |
| API key in the browser | N/A | Kept in `sessionStorage`, sent as a header, never in a URL or query string |
| Secrets in the repository | None | No keys, tokens or credentials are committed; `.env` is ignored |
| SQL injection | Parameterised queries only | SQLite statements use bound parameters |
| Path traversal on static files | Guarded | Static mounts use resolved paths under the dist directory |
| Dependency risk | `npm audit --omit=dev` clean; pip deps pinned to minimum versions | Audit runs in CI |
| Data at rest | Plain SQLite on the operator's disk | Documented; the volume is the operator's responsibility |

**Residual risk.** The service is single-user and has no login. It is meant
to run on localhost or behind a reverse proxy that terminates TLS and
enforces access. `PORTFOLIO_API_KEY` raises the bar but is a shared secret,
not an identity system.

---

## 5. Remaining technical debt

| Area | Debt | Severity |
|---|---|---|
| Market data | Yahoo Finance is unauthenticated, rate-limited, and occasionally changes shape; the total-return benchmark's methodology is the provider's, not independently verified | High — the app depends on it for everything |
| Position model | A position is one purchase at one date; no trade history, no partial sells, so lot-level tax and realised P&L are out of reach | Medium |
| Scenario framing | Replay applies today's weights to a past window; it is a stress test, not a reconstruction, and the UI has to keep saying so | Medium |
| Attribution | Single-index arithmetic: allocation and selection are not separated, and the residual is reported rather than eliminated | Medium |
| Monte Carlo | Multivariate normal; no fat tails, no regime switching, no fees or taxes | Medium |
| Currency | FX is a single spot rate per day; no hedging, no forward points, no intraday | Low |
| Bundle size | The ECharts chunk is 625 kB (211 kB gzipped). It is fetched on demand and cached, but a chart-heavy first visit still pays for it | Medium |
| Browser coverage | Playwright runs Chromium only (desktop and phone viewports); Safari and Firefox are not exercised | Low |
| Auth | No users, no sessions, no audit log; the API key is a shared secret | Low for a personal tool |
| Observability | Counters and latency percentiles live in process memory: they reset on restart and are not shipped anywhere | Low |

---

## 6. Next priorities

1. **Trade-level history**, so a position's acquisition date becomes a
   sequence of buys and sells, and realised P&L and tax lots become possible.
2. **A second browser engine in CI** (WebKit at minimum), now that the smoke
   suite exists.
3. **Reverse-proxy and TLS guidance**, plus a hardened example for a shared
   host.
4. **Benchmark sets**: compare against several benchmarks at once and show
   the spread, instead of one configured benchmark plus one ad-hoc query.
5. **Ship the metrics** to an external store if this ever runs as a service,
   rather than reading them from one process's memory.

---

## 7. Maturity assessment

| Dimension | Before | After |
|---|---|---|
| Correctness of the analytics | Not defensible | Defensible, documented, and tested; benchmark and currency effects are decomposed |
| Architecture | Flat scripts | Layered package with a clear seam |
| Persistence | JSON file | SQLite with validation, revisions, schema version and multiple portfolios |
| API design | Ad hoc | Versioned, documented, structured errors, pinned payload contract |
| Security | Localhost-only by accident | Deliberate, configurable, documented |
| Frontend | One long page | Six views, designed states, responsive, two palettes |
| Testing | 87 tests, no methodology coverage | 174 backend, 19 unit, 16 browser scenarios, contract and CI |
| Delivery | `make setup` | `make setup`, Docker, CI on four jobs |
| Documentation | Outdated | README, API reference, changelog, this report |

**Overall: a credible personal investment analytics tool.** The numbers can be
audited, the failure modes are designed rather than accidental, and the
deployment path is one command. It is not an institutional platform: it has
one user, one data source, and no authentication beyond a shared secret.
