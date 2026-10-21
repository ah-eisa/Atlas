# ATLAS — Portfolio Intelligence

[![CI](https://github.com/chrispathway/portfolio-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/chrispathway/portfolio-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted investment analytics workbench. Enter your positions, and ATLAS
turns them into an institutional-style terminal: time-weighted performance
against a benchmark, drawdown and risk decomposition, expected shortfall,
position-level risk contribution, and a Monte Carlo projection of the year
ahead.

Everything runs on your own machine. The only outbound requests are to Yahoo
Finance for public price history. There is no account, no telemetry, and no
server other than the one you run.

> **Not investment advice.** This is an analytics tool, not a recommendation
> engine. The portfolio committed to this repo is a worked example, not
> anyone's real net worth.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [The two data modes](#the-two-data-modes)
- [Entering positions](#entering-positions)
- [Methodology](#methodology)
- [Configuration](#configuration)
- [API](#api)
- [Testing](#testing)
- [Docker](#docker)
- [Security notes](#security-notes)
- [Limitations](#limitations)

---

## What it does

Six views over one analytics payload:

| View | Question it answers |
|---|---|
| **Overview** | What is the portfolio worth, how has it behaved, and what is driving the risk? |
| **Performance** | How did the portfolio compound, where did the money actually go, and how long was it underwater? |
| **Risk** | How volatile is it, what did the worst days look like, and which positions are responsible? |
| **Holdings** | What do I own, what did it cost, what is it worth now — and how do I change it? |
| **Projection** | What does the next year plausibly look like, and what is it assuming? |
| **Data** | Where did these numbers come from, when were they fetched, and how fresh are they? |

Analytics that are actually implemented, not decorative:

- **Time-weighted return** with acquisition-date activation and external
  cash-flow adjustment, so a position bought mid-period is not credited with
  returns that predate it. The money-weighted return (XIRR) is reported
  beside it, because the two answer different questions.
- **Benchmark-relative analytics**: Jensen alpha, beta, tracking error,
  information ratio, up/down capture, and correlation, all estimated on the
  common sample with a total-return benchmark. Any other symbol can be
  compared side by side without changing the stored portfolio.
- **Risk decomposition**: Euler (marginal-contribution) risk contribution per
  position, Herfindahl concentration, effective holdings, top-five weight.
- **Tail risk**: historical and parametric VaR at 95% and 99%, plus CVaR
  (expected shortfall) at both levels.
- **Currency decomposition**: the unrealised P&L is split between the
  instrument's own price move and the FX move, with the cost basis converted
  at the FX rate of the acquisition date.
- **Attribution**: active return per position, grouped into asset class and
  region, with the residual stated rather than hidden.
- **Scenario tools**: a historical replay of the current positions over a past
  window, target weights with allocation drift, and a rebalance preview.
- **Projection**: 10,000-path multivariate-normal Monte Carlo with percentile
  bands, a final-value histogram, and the assumptions stated on screen.

Every figure states its convention — annualised, geometric, over what window,
against what risk-free rate — because a number without its convention is not
interpretable.

---

## Architecture

```
portfolio-dashboard/
├── backend/
│   ├── app/                 # the whole service, importable as a package
│   │   ├── api.py           # FastAPI routes, middleware, error contract
│   │   ├── portfolio.py     # TWR engine and payload assembly
│   │   ├── metrics.py       # risk, return, benchmark and concentration maths
│   │   ├── montecarlo.py    # path simulation
│   │   ├── data.py          # yfinance fetch, FX, atomic on-disk cache
│   │   ├── store.py         # SQLite persistence (positions, settings)
│   │   ├── instruments.py   # ticker metadata lookup
│   │   ├── schemas.py       # strict Pydantic v2 request/response models
│   │   ├── serialize.py     # JSON-safe rounding, null handling
│   │   └── config.py        # environment-driven settings
│   ├── tests/               # 174 hermetic tests
│   ├── export_schema.py     # exports the committed payload JSON Schema
│   ├── generate_snapshot.py # writes the committed snapshot.json
│   └── setup_holdings.py    # interactive / CSV position import
├── frontend/
│   ├── e2e/                 # Playwright smoke suite (desktop + phone)
│   └── src/
│       ├── App.tsx          # shell, routing, loading/empty/error states
│       ├── views/           # the six views, each loaded on demand
│       ├── components/      # panels, charts, tables, editors
│       ├── lib/             # api client, types, formatting, routing, motion
│       └── styles/          # design tokens and layout
├── snapshot.json            # committed demo payload (no backend needed)
└── pytest.ini
```

**Backend.** FastAPI with a revision-aware analytics cache: prices and the
Monte Carlo are expensive, so they are rebuilt only when the stored positions
or the reporting currency actually change. Positions live in SQLite (WAL
mode); the price cache is an atomically-replaced JSON file with a format
version, so a stale cache is detected rather than misread.

**Frontend.** React 19 + TypeScript, built with Vite. ECharts for the
distribution/heatmap panels, Lightweight Charts for the time series, TanStack
Table for the holdings grid. The design system is an institutional one —
hairline grids, tabular figures, one accent colour, and no decoration that
does not carry information — with complete dark and light palettes. The six
views are lazily loaded, so the shell and the KPI band paint before the
charting libraries are fetched.

---

## Quick start

You need **Python 3.11+** and **Node 20+**.

### With `make` (macOS / Linux / WSL)

```bash
git clone https://github.com/chrispathway/portfolio-dashboard.git
cd portfolio-dashboard

make setup       # install backend + frontend dependencies
make dev         # open http://localhost:5173
```

### Without `make` (Windows PowerShell)

```powershell
git clone https://github.com/chrispathway/portfolio-dashboard.git
cd portfolio-dashboard

python -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt
cd frontend; npm install; cd ..

cd frontend; npm run dev
```

The committed `snapshot.json` is enough to render the whole dashboard — no
backend process, no market data fetch, no database. Start it and it works.

To use the live service instead (add/edit positions, refresh prices, change
the reporting currency, export):

```bash
# terminal 1 - the API
cd backend && python -m uvicorn app.api:app --port 8000

# terminal 2 - the UI, pointed at the API
cd frontend && VITE_DATA_SOURCE=api npm run dev
```

or simply open `http://localhost:5173/?source=api`.

### Regenerating the demo snapshot

```bash
cd backend && python generate_snapshot.py
```

This fetches live prices, recomputes every analytic, and rewrites
`snapshot.json` at the repository root. Commit the result if you want the
demo to reflect current markets.

---

## The two data modes

| | Snapshot mode (default) | API mode |
|---|---|---|
| Source | committed `snapshot.json` | live FastAPI service |
| Backend required | no | yes |
| Positions editable | no (read-only, and it says so) | yes |
| Refresh prices | no | yes |
| Change reporting currency | no | yes |
| Export positions | no | yes |
| Use it for | demos, CI, sharing, offline review | real use |

Both modes normalise to the same internal state, so no component knows or
cares which one is running. The active mode is always visible in the header
("Demo snapshot" / "Live API").

---

## Light and dark

The dashboard ships with two complete palettes, not one palette plus an
inversion:

- **Dark** — a true-black trading surface, the original design.
- **Light** — a paper-white instrument panel: white panels on a cool grey
  page, hairline rules instead of floating cards, and a categorical ramp that
  runs dark-to-light so the largest slice still reads strongest.

The switch lives in the header. The first visit follows the operating
system's `prefers-color-scheme`; once you choose, the choice is remembered and
survives a reload. The theme is applied before the first paint, so the page
never flashes the wrong background.

Both palettes are defined once, in `styles/tokens.css`, as CSS custom
properties. Everything else - panels, tables, charts, heatmaps, the editor -
reads those tokens, and the charting libraries read the same tokens at
runtime, so a palette switch repaints the charts as well as the page. Every
text role in both palettes clears the WCAG AA contrast ratio (4.5:1); the
context lines under the headline figures are the tightest, at 4.56:1 in the
light theme and 5.01:1 in the dark one.

---

## Entering positions

Positions are **current totals, not trades**: quantity and cost basis per
unit, plus the date the position was acquired. The acquisition date is what
activates the position in the time series, so the risk history starts when the
asset was actually bought.

Interactive:

```bash
cd backend && python setup_holdings.py
```

From CSV (`ticker,name,asset_class,region,currency,quantity,cost_basis_per_unit,acquired`):

```bash
cd backend && python setup_holdings.py --csv ../holdings.example.csv
```

In API mode you can also add, edit and delete positions from the Holdings
view, with instrument metadata looked up from Yahoo Finance for you.

---

## Methodology

This is the part that decides whether a dashboard is worth trusting.

**Time-weighted return.** Daily returns are computed from the portfolio's
market value, then chained geometrically. When a position is added mid-sample
it is activated on its acquisition date and does not dilute the earlier
history with a price move that predates it.

**External cash flows.** Contributions and withdrawals are excluded from
returns. They are recorded with a date and an amount instead of being
estimated from value changes, and the Performance view states the net invested
amount for each window so the absolute and percentage figures can be
reconciled by hand.

**Money-weighted return.** The time-weighted return measures the strategy; the
money-weighted return (XIRR over the recorded flows plus the terminal value)
measures the outcome for the money actually invested. Both are reported, and
the app does not pretend they should agree.

**Annualisation.** Volatility uses √252; return and beta use geometric
annualisation over the actual sample length. Drawdown, VaR and CVaR are
reported on the observed sample.

**Benchmark statistics.** Alpha and beta are estimated from daily excess
returns against the benchmark on the common sample; tracking error is the
annualised standard deviation of active returns; the information ratio is
active return over tracking error; capture ratios compare the portfolio's
up-day and down-day returns to the benchmark's. The default benchmark is the
S&P 500 **total-return** index (`^SP500TR`), because the holdings' prices are
dividend-adjusted; comparing them with a price-only index would bias alpha
downwards by roughly the dividend yield. The setting is explicit, and a price
index can be selected for comparison if wanted.

**Currency decomposition.** Unrealised P&L is split into a price effect and an
FX effect. The cost basis is converted at the FX rate of the acquisition date,
so a euro investor holding a dollar asset sees how much of the gain came from
the asset and how much from the currency.

**Risk contribution.** Euler decomposition of the covariance matrix gives each
position's share of portfolio variance, including the correlation effect. The
ratio of risk share to capital weight is the number that finds the position
that is quietly dominating the book.

**Attribution and scenarios.** Active return is attributed to positions and
grouped by asset class and region, with the residual shown rather than hidden.
A replay runs the current positions over a chosen past window, target weights
show allocation drift, and a what-if preview estimates the effect of a
rebalance without changing the stored portfolio.

**Monte Carlo.** Multivariate normal daily log returns, sampled from the
historical covariance, with buy-and-hold weight drift and no rebalancing. The
assumptions are printed next to the result, because a projection without its
assumptions is a guess with a confidence interval.

Every convention is also documented in the API reference
([API.md](API.md)) and restated in the Data view of the running app.

---

## Configuration

The backend reads its configuration from the environment. Every value has a
sensible default; nothing needs to be set for a local run.

| Variable | Default | Meaning |
|---|---|---|
| `PORTFOLIO_BASE_CURRENCY` | `EUR` | Fallback reporting currency |
| `PORTFOLIO_BENCHMARK` | `^SP500TR` | Benchmark symbol |
| `PORTFOLIO_BENCHMARK_NAME` | `S&P 500 (total return)` | Benchmark display name |
| `PORTFOLIO_BENCHMARK_INCLUDES_DIVIDENDS` | `true` | Whether the benchmark is a total-return series; reported next to the comparison |
| `PORTFOLIO_HISTORY_YEARS` | `2` | Years of daily history to fetch |
| `PORTFOLIO_RISK_FREE_RATE` | `0.02` | Annual risk-free rate (decimal) |
| `PORTFOLIO_MC_PATHS` | `10000` | Monte Carlo path count |
| `PORTFOLIO_CACHE_TTL_HOURS` | `12` | Age at which the price cache is refetched |
| `PORTFOLIO_DB_PATH` | `backend/data/portfolio.db` | SQLite database |
| `PORTFOLIO_HOLDINGS_PATH` | `backend/holdings.json` | Legacy JSON position file |
| `PORTFOLIO_CACHE_DIR` | `backend/.cache` | Price cache directory |
| `PORTFOLIO_SNAPSHOT_PATH` | `snapshot.json` | Where the snapshot generator writes |
| `PORTFOLIO_SEED_DEMO` | `true` | Seed the example portfolio on first boot |
| `PORTFOLIO_API_KEY` | *(empty)* | When set, data routes require `X-API-Key` |
| `PORTFOLIO_CORS_ORIGINS` | localhost:5173/4173 | Comma-separated allowed origins |

The frontend reads:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_DATA_SOURCE` | `snapshot` | `snapshot` or `api` |
| `VITE_API_BASE_URL` | page host on port 8000 | Where the API lives |
| `VITE_API_KEY` | *(empty)* | Optional key, if you do not want to type it |

A `?source=api` / `?source=snapshot` query parameter overrides the build-time
source, which is handy for demos and for testing both paths in one build.

---

## API

The service exposes a versioned JSON API under `/api/v1`. Full reference:
[API.md](API.md). Interactive docs are served at `/docs`.

```bash
curl http://localhost:8000/api/v1/health
curl http://localhost:8000/api/v1/portfolio/summary
curl http://localhost:8000/api/v1/portfolio/risk
curl -H "X-API-Key: $KEY" http://localhost:8000/api/v1/metrics
curl -H "X-API-Key: $KEY" http://localhost:8000/api/v1/positions
```

`/api/v1/metrics` reports request counts, latency percentiles and
analytics-cache decisions for the running process. It is behind the API key
when one is configured and stores no request identifiers.

---

## Testing

```bash
make test           # backend: pytest
make test-frontend  # frontend: Vitest
make test-e2e       # browser: Playwright, against the production build
```

The backend suite (174 tests) is hermetic: it never reaches Yahoo Finance,
never touches your real database, and uses a synthetic market with a fixed
seed, so results are reproducible. It covers the metric maths, the TWR and
XIRR methodology, the FX decomposition, the SQLite store and its schema
version, the HTTP contract (validation, duplicate tickers, empty portfolios,
exports, cash flows, portfolios, API-key protection, CORS on rejected keys)
and the error contract.

The payload contract is pinned twice over: `backend/tests/test_contract.py`
validates the committed `snapshot.json` against a JSON Schema generated from
the Pydantic models, and CI regenerates that schema
(`backend/export_schema.py`) and fails if it differs from the committed
`frontend/src/lib/payload-schema.json`. A backend change that silently alters
the payload therefore breaks the build instead of the dashboard.

The frontend unit tests (19) cover the pure logic — formatting, the hash
router and the snapshot normaliser. The Playwright smoke suite (8 scenarios,
run on a desktop and a phone viewport) answers the questions only a browser
can: the app mounts, every view renders panels, the charts fill their
containers, the figures are not zeros, counters settle, the theme switch
repaints and survives a reload, nothing overflows sideways, and the holdings
grid scrolls instead of breaking the layout. It runs against the production
bundle, which is also what the container ships.

```bash
cd frontend && npm run lint && npm run build
```

`npm run build` type-checks first (`tsc -b`), and the build reads
`snapshot.json`, so a malformed snapshot fails the build.

---

## Docker

```bash
docker compose up --build
```

Then open <http://localhost:8080>. The image serves the built SPA and the API
from one process on one port, so there is no CORS configuration to get wrong.
See [docker-compose.yml](docker-compose.yml) for the volume and environment
variables.

---

## Security notes

- **Your data stays local.** Holdings are stored in a SQLite file on your
  machine. Nothing is uploaded anywhere.
- **No credentials are committed.** The API key is read from the environment
  and typed into the UI at runtime; it is kept in `sessionStorage` and sent
  as an `X-API-Key` header, never in a URL.
- **The API is unauthenticated by default**, which is the right default for a
  single-user tool bound to localhost. Set `PORTFOLIO_API_KEY` before exposing
  it to a network: every data route then requires the header, while the
  liveness probe and the static SPA stay public. The metrics route is
  protected even though it carries no portfolio data.
- **CORS** is restricted to the known local origins plus a
  `localhost`/`127.0.0.1` regex; the CORS middleware wraps the API-key guard
  so a rejected key is still a readable `401` rather than an opaque browser
  error.
- **Responses** carry `X-Request-ID`, `X-Content-Type-Options: nosniff` and a
  restrictive content-security policy. API errors are structured
  (`{"detail": {"code", "message", "fields"?}}`) and never leak stack traces.
- **The upstream dependency is Yahoo Finance**, an unauthenticated public
  endpoint. It rate-limits, and it can be down. The app degrades to the last
  cached prices and says so in the Data view rather than inventing numbers.

---

## Limitations

- The Monte Carlo assumes multivariate-normal returns; fat tails and
  regime changes are not modelled, and no fees, taxes or slippage are
  included.
- Crypto trades on calendar days, equities on trading days; the aligned
  series uses the intersection of both calendars.
- Holdings' prices are dividend-adjusted by the data provider, and the
  default benchmark is a provider total-return series. Neither index
  methodology is independently verified.
- Attribution is the single-index arithmetic form: it attributes active
  return to positions, not to allocation versus selection within sectors.
- Position history is modelled as a single purchase at the acquisition date.
  It cannot reconstruct a sequence of buys and sells.
- There is no multi-user support, no authentication, and no audit log. This
  is a personal tool.

---

## License

MIT. See [LICENSE](LICENSE).
