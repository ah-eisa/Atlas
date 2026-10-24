# API Reference — ATLAS Portfolio Analytics

FastAPI service exposing portfolio analytics as JSON. Default base URL:
`http://localhost:8000`.

```bash
cd backend
python -m uvicorn app.api:app --port 8000        # from the backend directory
python -m uvicorn backend.app.api:app --port 8000 # from the repository root
```

Interactive OpenAPI docs: `/docs`. ReDoc: `/redoc`. Raw schema: `/openapi.json`.

Current API version: **2.3.0** (reported as `version` on the health route and
`api_version` in the bootstrap payload).

---

## Conventions

These hold for **every** endpoint.

| Rule | Detail |
|---|---|
| Base path | `/api/v1` for the current API. The pre-1.0 routes (`/holdings`, `/portfolio/...`, `/refresh`) still resolve as aliases. |
| Multi-portfolio | Every data route reads `X-Portfolio-Id` (an integer). Omitted or malformed, it falls back to the default portfolio rather than failing. |
| Currency | All monetary values are in the portfolio base currency, set in the store and echoed on every response. |
| `*_pct` fields | Always a **fraction**, never a percentage. `0.1234` means 12.34%. |
| Ratios | Sharpe, Sortino, Calmar, beta, capture ratios and correlations are unitless. |
| Dates | ISO `YYYY-MM-DD` strings. Timestamps are ISO 8601 UTC. |
| Missing values | Serialised as `null`. Payloads never contain `NaN`, `Infinity` or `-Infinity`, so `JSON.parse` always succeeds. |
| Envelope | Every analytic payload includes `as_of`, `base_currency` and `generated_at`. |
| `as_of` | The date of the most recent market close in the dataset — not today's date. |

### Errors

Every error uses the same shape:

```json
{ "detail": { "code": "validation_error", "message": "…", "fields": [ … ] } }
```

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid_format` | Unknown export format, or an unusable instrument symbol |
| `400` | `invalid_symbol` | The benchmark comparison symbol produced no usable history |
| `401` | `unauthorized` | `X-API-Key` is required (or wrong) on a protected route |
| `404` | `not_found` / `holding_not_found` / `cash_flow_not_found` / `instrument_not_found` | Unknown route, position, cash flow or symbol |
| `409` | `duplicate_ticker` / `empty_portfolio` / `default_portfolio` / `transaction_conflict` | Ticker already held, analytics requested for an empty portfolio, an attempt to delete the default portfolio, or deleting a purchase whose units a later sale has used |
| `422` | `validation_error` | Body failed schema validation; `fields` lists each offending field |
| `422` | `invalid_currency` / `invalid_target` / `invalid_window` / `invalid_ticker` | A well-formed request with an unusable value |
| `500` | `storage_error` | The database could not be written |
| `503` | `analytics_unavailable` | Prices could not be fetched and no usable cache exists |

A `401` response is still a normal CORS response: the CORS middleware wraps
the API-key guard, so a browser can read the body and show "authorisation
required" rather than an opaque CORS failure.

### Authentication

When `PORTFOLIO_API_KEY` is set, every route that returns portfolio data or
mutates positions requires the header:

```bash
curl -H "X-API-Key: $PORTFOLIO_API_KEY" http://localhost:8000/api/v1/positions
```

Public regardless of the key: `/api/v1/health`, `/openapi.json`, `/docs`,
`/redoc`, and the static SPA assets (they contain no data). The metrics route
is **not** public: it returns operational counters, and it is protected with
the same key.

### CORS

Allowed origins default to `http://localhost:5173`, `http://127.0.0.1:5173`,
`http://localhost:4173` and `http://127.0.0.1:4173`, plus a
`localhost`/`127.0.0.1` regex for any port. Override with
`PORTFOLIO_CORS_ORIGINS` (comma-separated).

### Response headers

| Header | Meaning |
|---|---|
| `X-Request-ID` | Correlation id, echoed from the request when supplied, generated otherwise |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | Restrictive policy for the served SPA |
| `Referrer-Policy` | `no-referrer` |

---

## Meta

### `GET /api/v1/health`

Fast liveness probe. Never downloads prices, never requires the API key, and
answers in milliseconds.

```json
{
  "status": "ok",
  "version": "2.3.0",
  "process": "669a3aeb",
  "base_currency": "EUR",
  "positions": 12,
  "api_key_required": false
}
```

### `GET /api/v1/metrics`

Operational counters for the running process, as JSON. Nothing in this payload
identifies a client, a route, a portfolio or a ticker: the registry stores
counts and timings only.

```json
{
  "version": "2.3.0",
  "process": "669a3aeb",
  "uptime_seconds": 1834.512,
  "requests": {
    "total": 241,
    "errors_5xx": 0,
    "by_status": { "200": 228, "201": 6, "204": 3, "304": 0, "401": 2, "404": 1, "422": 1 },
    "by_method": { "DELETE": 3, "GET": 219, "POST": 9, "PUT": 10 }
  },
  "latency_ms": {
    "samples": 241,
    "mean": 18.42,
    "p50": 4.11,
    "p95": 92.73,
    "p99": 214.8,
    "max": 512.33
  },
  "analytics_cache": { "hits": 218, "misses": 4, "builds": 4, "invalidations": 3 },
  "window": { "latency_samples": 2048 }
}
```

| Field | Meaning |
|---|---|
| `requests.total` | API requests completed since process start |
| `requests.by_status` / `by_method` | Counts grouped by HTTP status and method |
| `requests.errors_5xx` | Subset of the total that failed server-side |
| `latency_ms` | Nearest-rank percentiles over the most recent 2048 API requests; every reported value is a request that actually happened |
| `analytics_cache` | Cache decisions around the expensive analytics build: a rising `misses`/`builds` count means the key is changing (or prices are being refreshed) |
| `window.latency_samples` | Size of the rolling latency window |

Only paths under `/api/` are counted; static assets are ignored. The route
returns `Cache-Control: no-store` and requires the API key when one is
configured. A scrape that arrives while a request is in flight will not include
that request: the counters are updated after the response is produced.

### `GET /api/v1/bootstrap`

Everything the UI needs on first paint, in one request: settings, stored
positions and the complete analytics bundle.

```json
{
  "api_version": "2.3.0",
  "source": "api",
  "base_currency": "EUR",
  "portfolio_id": 1,
  "portfolios": [
    { "id": 1, "name": "Demo portfolio", "base_currency": "EUR", "created_at": "2026-10-21T…" }
  ],
  "positions": [ { "id": 1, "ticker": "AAPL", "…": "…" } ],
  "cash_flows": [
    { "id": 1, "occurred_on": "2026-03-02", "amount": 5000.0, "note": "Transfer in" }
  ],
  "analytics": {
    "health": { "…": "…" },
    "holdings": { "…": "…" },
    "summary": { "…": "…" },
    "history": { "…": "…" },
    "returns": { "…": "…" },
    "risk": { "…": "…" },
    "montecarlo": { "…": "…" }
  },
  "warnings": [],
  "error": null,
  "settings": {
    "benchmark": "^SP500TR",
    "benchmark_name": "S&P 500 (total return)",
    "benchmark_includes_dividends": true,
    "risk_free_rate": 0.02,
    "history_years": 2,
    "trading_days_per_year": 252,
    "api_key_required": false,
    "seed_demo": true
  }
}
```

`base_currency` and `portfolio_id` describe the portfolio the request was
about (`X-Portfolio-Id`), not the default one.

When the portfolio is empty, `analytics` is `null` and `error` explains why;
the response is still `200`, so the client can show the editor instead of an
error page.

### `POST /api/v1/portfolio/refresh`

Refetch prices from Yahoo Finance, rebuild every analytic, and return the
freshness stamps. Always bypasses the on-disk price cache.

```json
{
  "status": "refreshed",
  "as_of": "2026-10-20",
  "prices_fetched_at": "2026-10-21T12:34:31+00:00",
  "revision": 6
}
```

---

## Analytics

The core analytic routes are computed from the same cached model, so calling
them is cheap and consistent with one another.

### `GET /api/v1/portfolio/summary`

Headline numbers: value, cost, unrealised P&L, period changes, allocations.

```json
{
  "as_of": "2026-10-20",
  "base_currency": "EUR",
  "generated_at": "2026-10-21T09:58:51+00:00",
  "total_value": 84685.65,
  "total_cost": 84011.93,
  "total_unrealized_pnl": 673.72,
  "total_unrealized_pnl_pct": 0.008,
  "holdings_count": 12,
  "changes": {
    "day":   { "period": "day",   "pct": -0.0004, "absolute": -30.92,  "start_value": 84716.57, "end_value": 84685.65, "start_date": "2026-10-19", "flows": 0 },
    "week":  { "period": "week",  "pct": -0.0186, "absolute": -1600.76, "…": "…" },
    "month": { "period": "month", "pct":  0.0231, "absolute":  1912.08, "…": "…" },
    "ytd":   { "period": "ytd",   "pct":  0.0218, "absolute":  3268.04, "…": "…" },
    "all":   { "period": "all",   "pct": -0.0455, "absolute":   777.15, "…": "…" }
  },
  "allocation_by_class":    [ { "key": "Stock", "value": 35965.01, "allocation_pct": 0.4247, "holdings": 7 } ],
  "allocation_by_region":   [ { "key": "US",    "value": 30703.51, "allocation_pct": 0.3626, "holdings": 4 } ],
  "allocation_by_currency": [ { "key": "USD",   "value": 46161.23, "allocation_pct": 0.5451, "holdings": 7 } ],
  "fx_attribution": {
    "price_effect": 611.18, "fx_effect": 62.54, "unattributed": 0.0, "total": 673.72
  },
  "drift": {
    "has_targets": true,
    "positions": [
      { "ticker": "AAPL", "current_weight": 0.0786, "target_weight": 0.08,
        "drift": -0.0014, "trade_value": 118.56 }
    ],
    "total_drift": 0.0213, "turnover": 1804.12,
    "target_sum": 1.0, "residual": 0.0
  },
  "attribution": {
    "positions": [
      { "ticker": "AAPL", "name": "Apple", "region": "US", "asset_class": "Stock",
        "weight": 0.0786, "contribution_pct": 0.0041 }
    ],
    "by_region": [ { "key": "US", "contribution_pct": -0.0127 } ],
    "by_asset_class": [ { "key": "Stock", "contribution_pct": -0.0211 } ],
    "active_return_pct": -0.1963,
    "residual": -0.0012
  },
  "sparkline": { "dates": ["2026-06-12", "…"], "values": [62267.88, "…"] }
}
```

`changes[*].pct` is the time-weighted return over the window;
`changes[*].absolute` is the money change over the same window, net of
`flows` (external contributions and withdrawals). The two are deliberately
different measures: one is performance, the other is cash.

`fx_attribution` splits the total unrealised P&L into the instrument's price
move and the currency move. `unattributed` covers positions acquired before
the price history starts, where no entry price exists; it is reported rather
than spread across the other positions, and the four values reconcile to
`total_unrealized_pnl`.

`drift` is empty (`has_targets: false`) until at least one position has a
target weight. `total_drift` is half the sum of absolute drifts — the
turnover needed to rebalance a fully invested book — while `turnover` is the
smaller of the buys and the sells, in base currency. `residual` is what is
left over when the targets do not sum to one.

`attribution.contribution_pct` is each position's share of the active return,
computed daily and summed; `active_return_pct` is the compounded active
return, and `residual` is the difference between the two (compounding and
cash flows). The residual is stated, not hidden in a plug figure.

### `GET /api/v1/portfolio/history`

The daily time series behind every chart.

| Field | Meaning |
|---|---|
| `dates` | Trading dates, ascending |
| `portfolio` | Time-weighted growth index, `1.0` at the start of the sample |
| `portfolio_value` | Market value in the base currency |
| `benchmark_rebased` | Benchmark rebased onto the same start value |
| `drawdown_pct` | Drawdown from the running peak, always ≤ 0 |
| `per_holding` | Per-ticker value series, keyed by ticker |
| `flows` | External cash flow entries, `{ "date": "2026-03-02", "amount": 5000.0 }` |
| `flow_source` | `ledger` when the flows were recorded, `estimated` when inferred from acquisition dates |
| `methodology` | Human-readable statement of the return method |

`dates`, `portfolio`, `portfolio_value`, `benchmark_rebased` and
`drawdown_pct` are parallel arrays of equal length. `flows` is a sparse list
of the days on which money actually moved.

### `GET /api/v1/portfolio/returns`

Return distribution and aggregates.

| Field | Meaning |
|---|---|
| `daily_pct` | Daily time-weighted returns |
| `cumulative_pct` | Cumulative growth of the return series |
| `monthly_pct` | `[{ "month": "2026-10", "pct": -0.0012 }]` |
| `yearly_pct` | `[{ "year": "2026", "pct": 0.0218 }]` |
| `histogram` | `[{ "start": -0.0355, "end": -0.0332, "count": 2 }]` |
| `observations` | Number of return observations |
| `best_day` / `worst_day` | `{ "date": "2026-02-06", "pct": 0.0371 }` |
| `positive_days` / `negative_days` / `hit_rate_pct` | Hit-rate statistics |
| `average_gain_pct` / `average_loss_pct` | Mean up- and down-day return |
| `annualized_return_pct` | Geometric annualised return |
| `best_month_pct` / `worst_month_pct` | Best and worst calendar month |

### `GET /api/v1/portfolio/risk`

The full risk picture.

```json
{
  "as_of": "2026-10-20",
  "base_currency": "EUR",
  "generated_at": "2026-10-21T09:58:51+00:00",
  "lookback_days": 276,
  "risk_free_rate": 0.02,
  "trading_days_per_year": 252,
  "annualized_return_pct": -0.0417,
  "money_weighted_return_pct": -0.0284,
  "money_weighted_source": "ledger",
  "volatility_annualized_pct": 0.171,
  "downside_deviation_pct": 0.1223,
  "sharpe_ratio": -0.2794,
  "sortino_ratio": -0.3907,
  "calmar_ratio": -0.1747,
  "max_drawdown": {
    "pct": -0.2385,
    "peak_date": "2025-10-28",
    "trough_date": "2026-03-27",
    "peak_value": 93922.08,
    "trough_value": 71522.91,
    "recovery_date": null
  },
  "value_at_risk": {
    "95": { "confidence": 0.95, "historical_pct": 0.017, "parametric_pct": 0.0178,
            "historical_value": 1441.8, "parametric_value": 1509.66,
            "cvar_pct": 0.0225, "cvar_value": 1905.28 },
    "99": { "…": "…" }
  },
  "beta": { "value": 0.9906, "benchmark": "^SP500TR", "benchmark_name": "S&P 500 (total return)" },
  "benchmark": {
    "name": "S&P 500 (total return)", "symbol": "^SP500TR", "includes_dividends": true,
    "correlation": 0.732,
    "alpha_annualized_pct": -0.1749, "tracking_error_pct": 0.1165,
    "information_ratio": -1.5115, "up_capture": 0.9078, "down_capture": 1.1432,
    "max_drawdown_pct": -0.091, "return_pct": 0.1659,
    "annualized_return_pct": 0.1504, "volatility_annualized_pct": 0.1263,
    "sharpe_ratio": 1.0157, "observations": 276
  },
  "concentration": { "herfindahl": 0.1031, "effective_holdings": 9.703,
                     "top_five_pct": 0.5958, "largest_pct": 0.1695 },
  "risk_contribution": [
    { "ticker": "BTC-USD", "weight": 0.131, "contribution_pct": 0.2187 }
  ],
  "correlation": { "tickers": ["BTC-USD", "…"], "matrix": [[1.0, 0.42]] },
  "warnings": []
}
```

Notes:

- `max_drawdown.pct` is a fraction (negative). `recovery_date` is `null` when
  the drawdown has not been recovered yet.
- `money_weighted_return_pct` is the annualised XIRR of the recorded flows and
  the terminal value. `money_weighted_source` says whether those flows came
  from the ledger or were estimated from acquisition dates.
- `benchmark.includes_dividends` mirrors
  `PORTFOLIO_BENCHMARK_INCLUDES_DIVIDENDS`. The portfolio's own prices are
  dividend-adjusted, so a price-only benchmark biases alpha downwards by
  roughly the dividend yield; the flag exists so the UI can say which
  comparison is being made.
- `value_at_risk.<level>.cvar_value` is the expected loss *beyond* the VaR
  threshold, in the base currency; `cvar_pct` is the same figure as a
  fraction.
- `risk_contribution` sums to 1 in `contribution_pct`. It is an Euler
  decomposition of the covariance matrix, so it includes the correlation
  effect, not just the standalone volatility of each position.
- `correlation.matrix` is square, with the unit diagonal, and is ordered to
  match `correlation.tickers`.

### `GET /api/v1/portfolio/montecarlo`

| Field | Meaning |
|---|---|
| `paths` | Number of simulated paths |
| `horizon_days` | Trading days simulated |
| `start_value` | Portfolio value at the start of the projection |
| `dates` | Forward calendar of the projection |
| `percentile_bands` | `p5`, `p25`, `p50`, `p75`, `p95` value paths |
| `final_values` | The same percentiles at the end of the horizon |
| `histogram` | `[{ "start": 48986.52, "end": 53504.51, "count": 2, "probability": 0.0002 }]` |
| `expected_value` / `median_value` | Mean and median terminal value |
| `probability_below_start_pct` | Probability of finishing below the starting value |
| `expected_return_pct` / `annualized_drift_pct` | Expected and annualised drift |
| `assumptions` | The model description, printed in the UI next to the result |

### `GET /api/v1/holdings`

Priced positions.

```json
{
  "as_of": "2026-10-20",
  "base_currency": "EUR",
  "generated_at": "2026-10-21T09:58:51+00:00",
  "total_value": 84685.65,
  "holdings": [
    {
      "ticker": "AAPL",
      "name": "Apple",
      "asset_class": "Stock",
      "region": "US",
      "currency": "USD",
      "quantity": 22,
      "cost_basis_native": 327.22,
      "cost_basis_base": 286.41,
      "cost_total_base": 6301.1,
      "price_native": 339.5,
      "price_base": 302.7,
      "value_base": 6659.36,
      "allocation_pct": 0.0786,
      "unrealized_pnl": 358.26,
      "unrealized_pnl_pct": 0.0569,
      "price_effect": 339.04,
      "fx_effect": 19.22,
      "fx_rate_now": 0.8916,
      "fx_rate_at_acquisition": 0.8754,
      "price_native_at_acquisition": 327.22,
      "target_weight": 0.08,
      "drift": -0.0014,
      "day_change_pct": -0.0092,
      "acquired": "2026-07-15",
      "sparkline": [ 251.28, "…" ]
    }
  ]
}
```

`price_native` is in the instrument's own currency; `price_base` is converted
into the reporting currency. `sparkline` holds the last 90 daily closes in
base currency. `price_effect` and `fx_effect` are the two halves of the
unrealised P&L (both `null` when the acquisition predates the price history),
and `target_weight` / `drift` are `null` until a target is set.

---

## Positions

Positions are stored, not traded: a quantity, a cost basis per unit, and the
date the position was acquired. The acquisition date activates the position
in the time series.

### `GET /api/v1/positions`

```json
[
  {
    "id": 1,
    "ticker": "AAPL",
    "name": "Apple",
    "asset_class": "Stock",
    "region": "US",
    "currency": "USD",
    "quantity": 22,
    "cost_basis_per_unit": 327.22,
    "acquired": "2026-07-15",
    "target_weight": 0.08,
    "created_at": "2026-07-15T09:12:44+00:00",
    "updated_at": "2026-07-15T09:12:44+00:00"
  }
]
```

### `POST /api/v1/positions` → `201`

```json
{
  "ticker": "AAPL",
  "name": "Apple",
  "asset_class": "Stock",
  "region": "US",
  "currency": "USD",
  "quantity": 22,
  "cost_basis_per_unit": 327.22,
  "acquired": "2026-07-15",
  "target_weight": 0.08
}
```

Validation (422 with per-field messages):

| Field | Rule |
|---|---|
| `ticker` | Required, 1–20 characters, `A-Z 0-9 . - = ^` |
| `name` | Required, non-empty |
| `asset_class` | One of `Stock`, `ETF`, `Fund`, `Crypto`, `Bond`, `Cash`, `Other` |
| `region` | Optional, may be `null` |
| `currency` | Exactly three letters |
| `quantity` | Greater than zero |
| `cost_basis_per_unit` | Zero or greater |
| `acquired` | ISO date, not in the future |
| `target_weight` | Optional; zero or greater when supplied |

A ticker that is already held returns `409 duplicate_ticker`.

### `PUT /api/v1/positions/{id}`

Same body as create. Returns the updated position. Unknown id → `404`.

### `DELETE /api/v1/positions/{id}` → `204`

No body. Unknown id → `404`.

---

## Settings and instruments

### `GET /api/v1/instruments/{ticker}`

Metadata and last price for a symbol, used by the editor to fill in the form.

```json
{
  "ticker": "AAPL",
  "name": "Apple",
  "currency": "USD",
  "asset_class": "Stock",
  "region": "US",
  "last_price": 339.5,
  "as_of": "2026-10-20",
  "estimated": false
}
```

`estimated` is `true` when the symbol could not be resolved and the values
were inferred from the ticker shape. An unknown symbol returns `400`.

### `PUT /api/v1/settings/base-currency`

```json
{ "base_currency": "USD" }
```

Rebuilds every analytic in the new reporting currency. An unsupported code
returns `422`.

### `GET /api/v1/portfolio/export?format=json|csv`

Downloads the stored portfolio. `json` is lossless and carries positions and
cash flows; `csv` suits a spreadsheet and puts both in one table with a
`kind` column (`position` / `cash_flow`) so they can be told apart on import.
The CSV header is
`kind,ticker,name,asset_class,region,currency,quantity,cost_basis_per_unit,acquired,date,amount,note`.

---

## Portfolios

A portfolio has a name, its own reporting currency, and its own positions and
cash flows. The active one is selected per request with `X-Portfolio-Id`;
without the header the default portfolio is used.

### `GET /api/v1/portfolios`

```json
[
  { "id": 1, "name": "Demo portfolio", "base_currency": "EUR", "created_at": "2026-10-21T09:00:00+00:00" },
  { "id": 2, "name": "Pension", "base_currency": "USD", "created_at": "2026-10-21T09:04:11+00:00" }
]
```

### `POST /api/v1/portfolios` → `201`

```json
{ "name": "Pension", "base_currency": "USD" }
```

`base_currency` is optional; when omitted the service default is used. An
unsupported code returns `422 invalid_currency`.

### `DELETE /api/v1/portfolios/{id}` → `204`

Deletes the portfolio and everything in it. The default portfolio returns
`409 default_portfolio`: it is what the application falls back to, and
removing it would leave the service with nowhere to put positions.

---

## Cash flows

Recorded contributions and withdrawals are authoritative. Once the ledger has
an entry, the analytics use it instead of estimating flows from acquisition
dates; the source is published as `flow_source` / `money_weighted_source`.

### `GET /api/v1/cash-flows`

```json
[
  { "id": 1, "occurred_on": "2026-03-02", "amount": 5000.0, "note": "Transfer in" },
  { "id": 2, "occurred_on": "2026-06-14", "amount": -1200.0, "note": "Withdrawal" }
]
```

### `POST /api/v1/cash-flows` → `201`

```json
{ "occurred_on": "2026-03-02", "amount": 5000.0, "note": "Transfer in" }
```

A contribution is positive, a withdrawal negative; zero is rejected. The date
is ISO `YYYY-MM-DD` and cannot be in the future.

### `DELETE /api/v1/cash-flows/{id}` → `204`

No body. Unknown id → `404 cash_flow_not_found`.

---

## Scenarios

These three routes answer "what if" questions without changing the stored
portfolio.

### `GET /api/v1/portfolio/benchmark?symbol=^GSPC`

Compares the portfolio with any benchmark symbol on the portfolio's own
sample, returning the same statistics as the configured benchmark plus the two
aligned series.

```json
{
  "as_of": "2026-10-20", "base_currency": "EUR", "generated_at": "…",
  "symbol": "^GSPC", "name": "^GSPC",
  "correlation": 0.7291, "alpha_annualized_pct": -0.1823, "beta": 0.9871,
  "tracking_error_pct": 0.1172, "information_ratio": -1.5301,
  "up_capture": 0.9052, "down_capture": 1.1461,
  "max_drawdown_pct": -0.0932,
  "portfolio_return_pct": -0.0455, "benchmark_return_pct": 0.1508,
  "active_return_pct": -0.1963, "observations": 276,
  "dates": ["2025-09-15", "…"], "portfolio": [84685.65, "…"], "benchmark": [84685.65, "…"]
}
```

The symbol is uppercased and trimmed. An unusable symbol returns `400
invalid_symbol`; a missing one returns `422 invalid_symbol`.

### `GET /api/v1/portfolio/replay?start=2020-02-19&end=2020-03-23&notional=100000`

Runs the *current weights* over a past window and scales the result to
`notional`. This is a stress test of today's mix, not a reconstruction of what
was held then, and the UI says so.

| Field | Meaning |
|---|---|
| `start_date` / `end_date` | The clamped window actually used |
| `notional` | Starting value the series is scaled to |
| `dates`, `portfolio`, `benchmark` | Aligned value series |
| `drawdown_pct` | Drawdown from the running peak |
| `return_pct`, `annualized_return_pct`, `volatility_annualized_pct` | Window performance |
| `max_drawdown` | `{ pct, peak_date, trough_date }` |
| `best_day` / `worst_day` | `{ date, pct }` |
| `observations` | Trading days in the window |

A window with fewer than two trading days returns `422 invalid_window`.

### `POST /api/v1/portfolio/what-if`

```json
{ "targets": [ { "ticker": "AAPL", "weight": 0.10 } ] }
```

Rebuilds the model with the named positions at their proposed weight of
today's value; everything not named is scaled proportionally, so the portfolio
is still worth the same amount. Returns the implied `trades`, and a `current`
versus `proposed` headline (annualised return, volatility, Sharpe, beta, max
drawdown, effective holdings, top-five weight, total value). It is a risk
preview, not a forecast, and it does not write anything.

Weights that do not make sense for the book return `422 invalid_target`.

---

## Legacy aliases

The pre-1.0 routes still work and return the same payloads, so existing
bookmarks and scripts do not break:

`/health`, `/holdings`, `/portfolio/summary`, `/portfolio/history`,
`/portfolio/returns`, `/portfolio/risk`, `/portfolio/montecarlo`, `/refresh`.

They are hidden from the OpenAPI schema. New integrations should use
`/api/v1/…`.
