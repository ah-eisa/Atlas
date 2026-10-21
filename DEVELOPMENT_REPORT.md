# Development Report — ATLAS 2.0

An engineering record of the work that turned the original portfolio-dashboard
template into a standalone investment analytics application: what was wrong,
what changed, how it was verified, and what is still missing.

---

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
- **Motion is used once, on load.** Numbers count into place over one second
  and stop. `prefers-reduced-motion` disables it, and a backgrounded tab
  shows the final value rather than a frozen zero.
- **The editor is explicit about what it stores.** Quantity and cost basis
  per unit, plus an acquisition date, because those are the three fields that
  silently corrupt a portfolio valuation.
- **Failure is a state, not a crash.** Loading, empty portfolio, analytics
  unavailable, authorisation required, and connection failure are all
  designed states with their own copy and their own next action.

### 2.4 Delivery

- `Dockerfile` — multi-stage build; the SPA is compiled in stage one and
  copied into the runtime image, so the API and the dashboard share an
  origin and there is no CORS to configure.
- `docker-compose.yml` — the whole stack on `localhost:8080`, with volumes
  for the database and the price cache.
- `README.md` and `API.md` rewritten against the code that actually exists.
- `CHANGELOG.md` documents the breaking change in the data contract.

---

## 3. Verification

### 3.1 Backend

```
140 passed
```

The suite is hermetic: a synthetic market with a fixed seed, a temporary
SQLite database per test, and no network access. It covers:

- metric correctness (drawdown, VaR/CVaR, concentration, capture ratios);
- the methodology (TWR chaining, activation dates, cash-flow exclusion);
- the store (CRUD, revision counter, base currency, demo seeding);
- the HTTP contract (bootstrap, CRUD, validation, duplicate tickers, empty
  portfolios, export, API-key protection, CORS on rejected keys, security
  headers, structured 404s);
- the snapshot contract (the payload shape the frontend depends on).

### 3.2 Frontend

- `npm run lint` (oxlint) — clean.
- `npm run build` (`tsc -b` + Vite) — clean; the build reads the committed
  `snapshot.json`, so a malformed snapshot fails the build.
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
| Market data | Yahoo Finance is unauthenticated, rate-limited, and occasionally changes shape | High — the app depends on it for everything |
| Position model | A position is one purchase at one date; no trade history, no partial sells | Medium |
| Dividends | Prices are not total-return adjusted | Medium |
| Monte Carlo | Multivariate normal; no fat tails, no regime switching, no fees | Medium |
| Currency | FX is a single spot rate, not a hedged position | Low |
| Frontend tests | No unit-test harness for the frontend; verification is lint + typecheck + build + manual | Medium |
| Bundle size | The ECharts chunk is ~626 kB (211 kB gzipped) | Low |
| Auth | No users, no sessions, no audit log | Low for a personal tool |
| Observability | Structured logs only; no metrics endpoint | Low |

---

## 6. Next priorities

1. **Total-return prices** and a corporate-action-aware history, so the
   benchmark comparison is not distorted by dividend gaps.
2. **A frontend test harness** (Vitest + Testing Library) around the pure
   logic — formatting, the hash router, and the snapshot normaliser — which
   is where a regression would be cheapest to catch.
3. **Trade-level history**, so a position's acquisition date becomes a
   sequence of buys and sells, and the time series reflects it.
4. **Code-splitting by view** (lazy-loaded routes), which removes the ECharts
   chunk from the first paint.
5. **Reverse-proxy and TLS guidance**, plus a hardened example for a shared
   host.
6. **Multiple benchmarks** and a benchmark-relative "what if" view.

---

## 7. Maturity assessment

| Dimension | Before | After |
|---|---|---|
| Correctness of the analytics | Not defensible | Defensible, documented, and tested |
| Architecture | Flat scripts | Layered package with a clear seam |
| Persistence | JSON file | SQLite with validation and revisions |
| API design | Ad hoc | Versioned, documented, structured errors |
| Security | Localhost-only by accident | Deliberate, configurable, documented |
| Frontend | One long page | Six views, designed states, responsive |
| Testing | 87 tests, no methodology coverage | 141 tests, methodology included |
| Delivery | `make setup` | `make setup`, Docker, CI on three jobs |
| Documentation | Outdated | README, API reference, changelog, this report |

**Overall: a credible personal investment analytics tool.** The numbers can be
audited, the failure modes are designed rather than accidental, and the
deployment path is one command. It is not an institutional platform: it has
one user, one benchmark, one data source, and no authentication beyond a
shared secret.
