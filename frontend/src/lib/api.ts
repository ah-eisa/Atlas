/**
 * Data access: one configurable base URL, two interchangeable sources.
 *
 * `snapshot` (default) reads the committed `snapshot.json`, so the dashboard
 * runs with no backend process. `api` reads the live FastAPI service and enables
 * position editing. Both normalise to the same {@link PortfolioState}, so no
 * component knows which one is in use.
 *
 * Configuration, in order of precedence:
 *   1. `?source=api|snapshot` in the URL (handy for demos)
 *   2. `VITE_DATA_SOURCE` / `VITE_API_BASE_URL` in `.env`
 *   3. Defaults: snapshot, and the API on the page's own host at port 8000
 *
 * The API key is never put in a URL. In live mode the UI stores it in
 * `sessionStorage` after the user enters it.
 */

import type {
  Analytics,
  BlackScholesInput,
  BlackScholesOutput,
  BondCalculatorInput,
  BondCalculatorOutput,
  BootstrapResponse,
  CashFlow,
  DataSource,
  HistoricalYieldPoint,
  InstrumentInfo,
  MacroHistoryPoint,
  MacroSummaryResponse,
  OptionChainResponse,
  OrderInput,
  Portfolio,
  PortfolioState,
  Position,
  PositionInput,
  RealizedPnlSummary,
  SecFilingsResponse,
  Snapshot,
  Transaction,
  YieldCurveSnapshot,
} from './types'

const DEFAULT_API_PORT = 8000
const API_KEY_STORAGE = 'atlas.apiKey'
const PORTFOLIO_STORAGE = 'atlas.portfolioId'

/** The portfolio the user last selected, remembered between visits. */
export function getStoredPortfolioId(): number {
  if (typeof window === 'undefined') return 1
  const raw = Number.parseInt(window.localStorage.getItem(PORTFOLIO_STORAGE) ?? '1', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

export function setStoredPortfolioId(id: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PORTFOLIO_STORAGE, String(id))
}

export interface DataConfig {
  source: DataSource
  apiBaseUrl: string
  snapshotUrl: string
  apiKey: string
  /** The portfolio to read, in live mode. */
  portfolioId: number
}

export class ApiError extends Error {
  status: number
  code: string
  fields: { field: string; message: string }[]

  constructor(
    message: string,
    options: { status?: number; code?: string; fields?: { field: string; message: string }[] } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'network_error'
    this.fields = options.fields ?? []
  }
}

function readSourceOverride(): DataSource | null {
  if (typeof window === 'undefined') return null
  const requested = new URLSearchParams(window.location.search).get('source')
  return requested === 'api' || requested === 'snapshot' ? requested : null
}

export function getStoredApiKey(): string {
  if (typeof window === 'undefined') return ''
  return window.sessionStorage.getItem(API_KEY_STORAGE) ?? ''
}

export function setStoredApiKey(key: string): void {
  if (typeof window === 'undefined') return
  if (key) window.sessionStorage.setItem(API_KEY_STORAGE, key)
  else window.sessionStorage.removeItem(API_KEY_STORAGE)
}

/**
 * Default API origin for live mode.
 *
 * Derived from the host serving the page rather than hard-coded to
 * `localhost`. A page opened at `http://127.0.0.1:5173` must talk to
 * `http://127.0.0.1:8000`: the two names are different origins, so a
 * hard-coded `localhost` target is rejected by CORS (and by proxies that
 * resolve `localhost` to IPv6) the moment anyone opens the app by its
 * numeric address.
 */
function defaultApiBaseUrl(): string {
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_API_PORT}`
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${DEFAULT_API_PORT}`
}

/** Resolve the active configuration from URL params and build-time env. */
export function resolveConfig(): DataConfig {
  const envSource = import.meta.env.VITE_DATA_SOURCE as DataSource | undefined
  const source = readSourceOverride() ?? (envSource === 'api' ? 'api' : 'snapshot')

  return {
    source,
    apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? defaultApiBaseUrl(),
    // BASE_URL keeps this correct when the app is served from a sub-path.
    snapshotUrl: `${import.meta.env.BASE_URL}snapshot.json`,
    apiKey: (import.meta.env.VITE_API_KEY as string | undefined) || getStoredApiKey(),
    portfolioId: getStoredPortfolioId(),
  }
}

/** Fetch JSON, turning any non-2xx or transport failure into an ApiError. */
async function requestJson<T>(
  url: string,
  config: DataConfig,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  if (config.apiKey) headers.set('X-API-Key', config.apiKey)
  // The portfolio is part of the request context, not the body: every route
  // answers for one portfolio, and a header keeps the URL shareable.
  if (config.source === 'api' && config.portfolioId) {
    headers.set('X-Portfolio-Id', String(config.portfolioId))
  }

  let response: Response
  try {
    response = await fetch(url, { ...init, headers, signal })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(`Could not reach ${url}. Is the backend running?`)
  }

  if (!response.ok) {
    let message = `${url} returned ${response.status} ${response.statusText}`
    let code = 'http_error'
    let fields: { field: string; message: string }[] = []
    try {
      const body = (await response.json()) as {
        detail?: string | { code?: string; message?: string; fields?: typeof fields }
      }
      if (typeof body.detail === 'string') {
        message = body.detail
      } else if (body.detail) {
        code = body.detail.code ?? code
        message = body.detail.message ?? message
        fields = body.detail.fields ?? []
      }
    } catch {
      // A non-JSON error page (proxy, crash) keeps the status-based message.
    }
    throw new ApiError(message, { status: response.status, code, fields })
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/**
 * Turn a committed snapshot into the state the components read.
 *
 * Exported for the unit tests: this is the function where a renamed field
 * becomes a screen full of zeros.
 */
export function snapshotToState(snapshot: Snapshot): PortfolioState {
  const endpoints = snapshot.endpoints
  if (!endpoints?.['/portfolio/summary']) {
    throw new ApiError(
      'This snapshot is missing its analytics payloads. Regenerate it with backend/generate_snapshot.py.',
      { code: 'invalid_snapshot' },
    )
  }

  const analytics: Analytics = {
    health: endpoints['/health'],
    holdings: endpoints['/holdings'],
    summary: endpoints['/portfolio/summary'],
    history: endpoints['/portfolio/history'],
    returns: endpoints['/portfolio/returns'],
    risk: endpoints['/portfolio/risk'],
    montecarlo: endpoints['/portfolio/montecarlo'],
  }

  // The snapshot is the demo output, not a database. Positions are derived so
  // the read-only holdings view can describe cost basis and acquisition dates.
  const positions: Position[] = analytics.holdings.holdings.map((holding, index) => ({
    id: index + 1,
    ticker: holding.ticker,
    name: holding.name,
    asset_class: holding.asset_class,
    region: holding.region,
    currency: holding.currency,
    quantity: holding.quantity,
    cost_basis_per_unit: holding.cost_basis_native,
    acquired: holding.acquired,
    target_weight: null,
    created_at: snapshot.generated_at,
    updated_at: snapshot.generated_at,
  }))

  return {
    source: 'snapshot',
    apiVersion: analytics.health.version,
    baseCurrency: snapshot.base_currency,
    analytics,
    positions,
    cashFlows: [],
    portfolioId: 1,
    portfolios: [],
    settings: {
      benchmark: analytics.health.benchmark,
      benchmark_name: analytics.risk.benchmark.name,
      benchmark_includes_dividends: analytics.risk.benchmark.includes_dividends,
      risk_free_rate: analytics.risk.risk_free_rate,
      history_years: Math.max(1, Math.round(analytics.health.history_days / 252)),
      trading_days_per_year: analytics.risk.trading_days_per_year,
      api_key_required: false,
      seed_demo: false,
    },
    warnings: analytics.health.warnings ?? [],
    error: null,
    editable: false,
  }
}

/** Load everything the UI needs from whichever source is configured. */
export async function loadPortfolio(
  config: DataConfig,
  signal?: AbortSignal,
): Promise<PortfolioState> {
  if (config.source === 'snapshot') {
    const snapshot = await requestJson<Snapshot>(config.snapshotUrl, config, {}, signal)
    return snapshotToState(snapshot)
  }

  const base = config.apiBaseUrl.replace(/\/$/, '')
  const bootstrap = await requestJson<BootstrapResponse>(
    `${base}/api/v1/bootstrap`,
    config,
    {},
    signal,
  )
  return {
    source: 'api',
    apiVersion: bootstrap.api_version,
    baseCurrency: bootstrap.base_currency,
    analytics: bootstrap.analytics,
    positions: bootstrap.positions,
    cashFlows: bootstrap.cash_flows ?? [],
    portfolioId: bootstrap.portfolio_id ?? config.portfolioId,
    portfolios: bootstrap.portfolios ?? [],
    settings: bootstrap.settings,
    warnings: bootstrap.warnings,
    error: bootstrap.error,
    editable: true,
  }
}

function apiUrl(config: DataConfig, path: string): string {
  return `${config.apiBaseUrl.replace(/\/$/, '')}${path}`
}

export function createPosition(config: DataConfig, input: PositionInput): Promise<Position> {
  return requestJson<Position>(apiUrl(config, '/api/v1/positions'), config, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updatePosition(
  config: DataConfig,
  id: number,
  input: PositionInput,
): Promise<Position> {
  return requestJson<Position>(apiUrl(config, `/api/v1/positions/${id}`), config, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deletePosition(config: DataConfig, id: number): Promise<void> {
  return requestJson<void>(apiUrl(config, `/api/v1/positions/${id}`), config, {
    method: 'DELETE',
  })
}

export function createCashFlow(
  config: DataConfig,
  input: { occurred_on: string; amount: number; note?: string },
): Promise<CashFlow> {
  return requestJson<CashFlow>(apiUrl(config, '/api/v1/cash-flows'), config, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteCashFlow(config: DataConfig, id: number): Promise<void> {
  return requestJson<void>(apiUrl(config, `/api/v1/cash-flows/${id}`), config, {
    method: 'DELETE',
  })
}

export function listPortfolios(config: DataConfig): Promise<Portfolio[]> {
  return requestJson<Portfolio[]>(apiUrl(config, '/api/v1/portfolios'), config, {})
}
export function createPortfolio(
  config: DataConfig,
  name: string,
  baseCurrency: string,
): Promise<Portfolio> {
  return requestJson<Portfolio>(apiUrl(config, '/api/v1/portfolios'), config, {
    method: 'POST',
    body: JSON.stringify({ name, base_currency: baseCurrency }),
  })
}

export function deletePortfolio(config: DataConfig, id: number): Promise<void> {
  return requestJson<void>(apiUrl(config, `/api/v1/portfolios/${id}`), config, {
    method: 'DELETE',
  })
}

export function listTransactions(config: DataConfig): Promise<Transaction[]> {
  return requestJson<Transaction[]>(apiUrl(config, '/api/v1/transactions'), config, {})
}

export function placeOrder(config: DataConfig, input: OrderInput): Promise<Transaction> {
  return requestJson<Transaction>(apiUrl(config, '/api/v1/orders'), config, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteTransaction(config: DataConfig, id: number): Promise<void> {
  return requestJson<void>(apiUrl(config, `/api/v1/transactions/${id}`), config, {
    method: 'DELETE',
  })
}

export function getRealizedPnlSummary(config: DataConfig): Promise<RealizedPnlSummary> {
  return requestJson<RealizedPnlSummary>(
    apiUrl(config, '/api/v1/portfolio/realized-pnl'),
    config,
    {},
  )
}

/** The risk before and after a proposed rebalance. */
export interface WhatIfResult {
  trades: {
    ticker: string
    from_weight: number
    to_weight: number
    trade_value: number
  }[]
  current: {
    annualized_return_pct: number | null
    volatility_annualized_pct: number | null
    sharpe_ratio: number | null
    beta: number | null
    max_drawdown_pct: number | null
    effective_holdings: number | null
    top_five_pct: number | null
    total_value: number | null
  }
  proposed: {
    annualized_return_pct: number | null
    volatility_annualized_pct: number | null
    sharpe_ratio: number | null
    beta: number | null
    max_drawdown_pct: number | null
    effective_holdings: number | null
    top_five_pct: number | null
    total_value: number | null
  }
}

export function fetchWhatIf(
  config: DataConfig,
  targets: { ticker: string; weight: number }[],
): Promise<WhatIfResult> {
  return requestJson<WhatIfResult>(apiUrl(config, '/api/v1/portfolio/what-if'), config, {
    method: 'POST',
    body: JSON.stringify({ targets }),
  })
}

/** A comparison against a benchmark other than the configured one. */
export interface BenchmarkComparison {
  symbol: string
  name: string
  correlation: number | null
  alpha_annualized_pct: number | null
  beta: number | null
  tracking_error_pct: number | null
  information_ratio: number | null
  up_capture: number | null
  down_capture: number | null
  max_drawdown_pct: number | null
  portfolio_return_pct: number | null
  benchmark_return_pct: number | null
  active_return_pct: number | null
  observations: number
  dates: string[]
  portfolio: number[]
  benchmark: number[]
}

export function fetchBenchmark(
  config: DataConfig,
  symbol: string,
  signal?: AbortSignal,
): Promise<BenchmarkComparison> {
  return requestJson<BenchmarkComparison>(
    `${apiUrl(config, '/api/v1/portfolio/benchmark')}?symbol=${encodeURIComponent(symbol)}`,
    config,
    {},
    signal,
  )
}

/** A stress test of the current positions over a past window. */
export interface ReplayPayload {
  as_of: string
  base_currency: string
  start_date: string
  end_date: string
  notional: number
  dates: string[]
  portfolio: number[]
  benchmark: number[]
  drawdown_pct: number[]
  return_pct: number | null
  annualized_return_pct: number | null
  volatility_annualized_pct: number | null
  max_drawdown: { pct: number | null; peak_date: string | null; trough_date: string | null }
  best_day: { date: string | null; pct: number | null }
  worst_day: { date: string | null; pct: number | null }
  observations: number
}

export function fetchReplay(
  config: DataConfig,
  params: { start?: string; end?: string; notional?: number },
  signal?: AbortSignal,
): Promise<ReplayPayload> {
  const query = new URLSearchParams()
  if (params.start) query.set('start', params.start)
  if (params.end) query.set('end', params.end)
  if (params.notional) query.set('notional', String(params.notional))
  const suffix = query.toString()
  return requestJson<ReplayPayload>(
    `${apiUrl(config, '/api/v1/portfolio/replay')}${suffix ? `?${suffix}` : ''}`,
    config,
    {},
    signal,
  )
}

export function lookupInstrument(
  config: DataConfig,
  ticker: string,
  signal?: AbortSignal,
): Promise<InstrumentInfo> {
  return requestJson<InstrumentInfo>(
    apiUrl(config, `/api/v1/instruments/${encodeURIComponent(ticker)}`),
    config,
    {},
    signal,
  )
}

export function updateBaseCurrency(config: DataConfig, baseCurrency: string): Promise<{ base_currency: string }> {
  return requestJson<{ base_currency: string }>(
    apiUrl(config, '/api/v1/settings/base-currency'),
    config,
    { method: 'PUT', body: JSON.stringify({ base_currency: baseCurrency }) },
  )
}

export interface RefreshResult {
  status: string
  as_of: string
  prices_fetched_at: string
}

export function refreshPortfolio(config: DataConfig): Promise<RefreshResult> {
  return requestJson<RefreshResult>(apiUrl(config, '/api/v1/portfolio/refresh'), config, {
    method: 'POST',
  })
}

export function exportUrl(config: DataConfig, format: 'json' | 'csv'): string {
  return apiUrl(config, `/api/v1/portfolio/export?format=${format}`)
}

/**
 * Download an export through `fetch` rather than a plain link so the API key
 * travels in the header. An anchor cannot attach one, which would make every
 * export fail on a protected deployment.
 */
export async function downloadExport(
  config: DataConfig,
  format: 'json' | 'csv',
): Promise<void> {
  const headers = new Headers({ Accept: format === 'json' ? 'application/json' : 'text/csv' })
  if (config.apiKey) headers.set('X-API-Key', config.apiKey)

  const response = await fetch(exportUrl(config, format), { headers })
  if (!response.ok) {
    throw new ApiError(`Export failed with status ${response.status}.`, {
      status: response.status,
      code: 'export_failed',
    })
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `portfolio.${format}`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function apiBase(config: DataConfig): string {
  return config.apiBaseUrl.replace(/\/$/, '')
}

// --------------------------------------------------------------------------
// Fixed Income & Yield Curve API
// --------------------------------------------------------------------------

const SAMPLE_YIELD_CURVE: YieldCurveSnapshot = {
  as_of_date: '2025-04-10',
  curve_points: [
    { tenor: '1M', series_id: 'DGS1MO', years: 0.0833, yield_pct: 4.36 },
    { tenor: '3M', series_id: 'DGS3MO', years: 0.25, yield_pct: 4.34 },
    { tenor: '6M', series_id: 'DGS6MO', years: 0.5, yield_pct: 4.17 },
    { tenor: '1Y', series_id: 'DGS1', years: 1.0, yield_pct: 3.97 },
    { tenor: '2Y', series_id: 'DGS2', years: 2.0, yield_pct: 3.84 },
    { tenor: '5Y', series_id: 'DGS5', years: 5.0, yield_pct: 4.04 },
    { tenor: '7Y', series_id: 'DGS7', years: 7.0, yield_pct: 4.21 },
    { tenor: '10Y', series_id: 'DGS10', years: 10.0, yield_pct: 4.4 },
    { tenor: '20Y', series_id: 'DGS20', years: 20.0, yield_pct: 4.9 },
    { tenor: '30Y', series_id: 'DGS30', years: 30.0, yield_pct: 4.86 },
  ],
  curve_points_1m_ago: [
    { tenor: '1M', series_id: 'DGS1MO', years: 0.0833, yield_pct: 4.41 },
    { tenor: '3M', series_id: 'DGS3MO', years: 0.25, yield_pct: 4.38 },
    { tenor: '6M', series_id: 'DGS6MO', years: 0.5, yield_pct: 4.25 },
    { tenor: '1Y', series_id: 'DGS1', years: 1.0, yield_pct: 4.08 },
    { tenor: '2Y', series_id: 'DGS2', years: 2.0, yield_pct: 3.98 },
    { tenor: '5Y', series_id: 'DGS5', years: 5.0, yield_pct: 4.15 },
    { tenor: '7Y', series_id: 'DGS7', years: 7.0, yield_pct: 4.32 },
    { tenor: '10Y', series_id: 'DGS10', years: 10.0, yield_pct: 4.48 },
    { tenor: '20Y', series_id: 'DGS20', years: 20.0, yield_pct: 4.88 },
    { tenor: '30Y', series_id: 'DGS30', years: 30.0, yield_pct: 4.82 },
  ],
  curve_points_1y_ago: [
    { tenor: '1M', series_id: 'DGS1MO', years: 0.0833, yield_pct: 5.49 },
    { tenor: '3M', series_id: 'DGS3MO', years: 0.25, yield_pct: 5.45 },
    { tenor: '6M', series_id: 'DGS6MO', years: 0.5, yield_pct: 5.4 },
    { tenor: '1Y', series_id: 'DGS1', years: 1.0, yield_pct: 5.19 },
    { tenor: '2Y', series_id: 'DGS2', years: 2.0, yield_pct: 4.97 },
    { tenor: '5Y', series_id: 'DGS5', years: 5.0, yield_pct: 4.61 },
    { tenor: '7Y', series_id: 'DGS7', years: 7.0, yield_pct: 4.59 },
    { tenor: '10Y', series_id: 'DGS10', years: 10.0, yield_pct: 4.55 },
    { tenor: '20Y', series_id: 'DGS20', years: 20.0, yield_pct: 4.76 },
    { tenor: '30Y', series_id: 'DGS30', years: 30.0, yield_pct: 4.64 },
  ],
  spread_10y_2y_bps: 56.0,
  spread_10y_3m_bps: 6.0,
  curve_status: 'NORMAL',
  us10y_yield: 4.4,
  us2y_yield: 3.84,
  us3m_yield: 4.34,
  aaa_yield: 5.29,
  baa_yield: 5.93,
  credit_spread_baa_aaa_bps: 64.0,
  credit_spread_baa_10y_bps: 153.0,
}

export async function getYieldCurve(
  config: DataConfig,
  asOf?: string,
): Promise<YieldCurveSnapshot> {
  if (config.source === 'snapshot') {
    return SAMPLE_YIELD_CURVE
  }
  const query = asOf ? `?as_of=${encodeURIComponent(asOf)}` : ''
  try {
    return await requestJson<YieldCurveSnapshot>(
      apiUrl(config, `/api/v1/fixed-income/yield-curve${query}`),
      config,
    )
  } catch {
    return SAMPLE_YIELD_CURVE
  }
}

export async function getHistoricalYields(
  config: DataConfig,
  range: string = '1Y',
): Promise<HistoricalYieldPoint[]> {
  if (config.source === 'snapshot') {
    return []
  }
  try {
    return await requestJson<HistoricalYieldPoint[]>(
      apiUrl(config, `/api/v1/fixed-income/history?range=${encodeURIComponent(range)}`),
      config,
    )
  } catch {
    return []
  }
}

export async function calculateBond(
  config: DataConfig,
  input: BondCalculatorInput,
): Promise<BondCalculatorOutput> {
  if (config.source === 'snapshot') {
    // Client-side calculation fallback
    const face = input.face_value
    const c = face * (input.coupon_rate / 100) / input.frequency
    const y = (input.ytm / 100) / input.frequency
    const n = Math.max(1, Math.round(input.years_to_maturity * input.frequency))
    let pvSum = 0
    let durSum = 0
    let convSum = 0
    for (let t = 1; t <= n; t++) {
      const cf = c + (t === n ? face : 0)
      const df = Math.pow(1 + y, -t)
      const pv = cf * df
      pvSum += pv
      durSum += (t / input.frequency) * pv
      convSum += t * (t + 1) * cf * df
    }
    const macDur = pvSum > 0 ? durSum / pvSum : 0
    const modDur = macDur / (1 + y)
    const conv = convSum / (pvSum * Math.pow(1 + y, 2) * Math.pow(input.frequency, 2))
    const dv01 = modDur * pvSum * 0.0001
    const scenarios = [-200, -100, -50, -25, 25, 50, 100, 200].map((shift) => {
      const newYtm = Math.max(0.001, input.ytm + shift / 100)
      const newY = (newYtm / 100) / input.frequency
      let re = 0
      for (let t = 1; t <= n; t++) {
        const cf = c + (t === n ? face : 0)
        re += cf * Math.pow(1 + newY, -t)
      }
      return {
        shift_bps: shift,
        new_ytm: Number(newYtm.toFixed(3)),
        repriced_bond: Number(re.toFixed(2)),
        price_change_dollars: Number((re - pvSum).toFixed(2)),
        price_change_pct: Number(((re - pvSum) / pvSum * 100).toFixed(2)),
      }
    })
    return {
      price: Number(pvSum.toFixed(2)),
      clean_price: Number(pvSum.toFixed(2)),
      macaulay_duration: Number(macDur.toFixed(3)),
      modified_duration: Number(modDur.toFixed(3)),
      convexity: Number(conv.toFixed(3)),
      dv01: Number(dv01.toFixed(3)),
      annual_coupon_income: Number((face * (input.coupon_rate / 100)).toFixed(2)),
      current_yield: Number(((face * (input.coupon_rate / 100) / pvSum) * 100).toFixed(2)),
      scenarios,
    }
  }

  return requestJson<BondCalculatorOutput>(apiUrl(config, '/api/v1/fixed-income/calculator'), config, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// --------------------------------------------------------------------------
// Macroeconomic & SEC EDGAR API
// --------------------------------------------------------------------------

const SAMPLE_MACRO_SUMMARY: MacroSummaryResponse = {
  as_of: '2026-10-21',
  indicators: [
    {
      series_id: 'DFF',
      name: 'Federal Funds Effective Rate',
      category: 'Monetary Policy',
      latest_value: 4.83,
      unit: '%',
      observation_date: '2026-10-21',
      previous_value: 4.88,
      change: -0.05,
      change_pct: -1.02,
    },
    {
      series_id: 'CPIAUCSL',
      name: 'Headline CPI Inflation (YoY)',
      category: 'Inflation',
      latest_value: 2.7,
      unit: '%',
      observation_date: '2026-09-30',
      previous_value: 2.6,
      change: 0.1,
      change_pct: 3.85,
    },
    {
      series_id: 'CPILFESL',
      name: 'Core CPI Inflation (YoY)',
      category: 'Inflation',
      latest_value: 3.2,
      unit: '%',
      observation_date: '2026-09-30',
      previous_value: 3.3,
      change: -0.1,
      change_pct: -3.03,
    },
    {
      series_id: 'UNRATE',
      name: 'Unemployment Rate',
      category: 'Labor Market',
      latest_value: 4.1,
      unit: '%',
      observation_date: '2026-09-30',
      previous_value: 4.1,
      change: 0.0,
      change_pct: 0.0,
    },
    {
      series_id: 'GDPC1',
      name: 'Real GDP Growth (Annualized)',
      category: 'Growth',
      latest_value: 2.8,
      unit: '%',
      observation_date: '2026-06-30',
      previous_value: 2.5,
      change: 0.3,
      change_pct: 12.0,
    },
    {
      series_id: 'M2SL',
      name: 'M2 Money Supply',
      category: 'Money & Liquidity',
      latest_value: 21.45,
      unit: '$T',
      observation_date: '2026-09-30',
      previous_value: 21.4,
      change: 0.05,
      change_pct: 0.23,
    },
  ],
}

export async function getMacroSummary(config: DataConfig): Promise<MacroSummaryResponse> {
  if (config.source === 'snapshot') {
    return SAMPLE_MACRO_SUMMARY
  }
  try {
    return await requestJson<MacroSummaryResponse>(apiUrl(config, '/api/v1/macro/summary'), config)
  } catch {
    return SAMPLE_MACRO_SUMMARY
  }
}

export async function getMacroHistory(
  config: DataConfig,
  series: string = 'CPIAUCSL',
  range: string = '5Y',
): Promise<MacroHistoryPoint[]> {
  if (config.source === 'snapshot') {
    return []
  }
  try {
    return await requestJson<MacroHistoryPoint[]>(
      apiUrl(config, `/api/v1/macro/history?series=${encodeURIComponent(series)}&range=${encodeURIComponent(range)}`),
      config,
    )
  } catch {
    return []
  }
}

export async function getSecFilings(
  config: DataConfig,
  ticker: string,
  form?: string,
  limit: number = 30,
): Promise<SecFilingsResponse> {
  const clean = ticker.trim().toUpperCase()
  const formParam = form ? `&form=${encodeURIComponent(form)}` : ''
  const url = apiUrl(config, `/api/v1/sec/filings?ticker=${encodeURIComponent(clean)}&limit=${limit}${formParam}`)

  if (config.source === 'snapshot') {
    return {
      ticker: clean,
      cik: '0000320193',
      company_name: `${clean} Inc.`,
      filings: [
        {
          form: '10-K',
          filing_date: '2025-11-01',
          report_date: '2025-09-30',
          accession_number: '0000320193-25-000079',
          primary_document: 'annual_report.htm',
          description: 'Annual Report for fiscal year ended Sep 30, 2025',
          url: 'https://www.sec.gov/edgar/browse/?CIK=0000320193',
          is_xbrl: true,
        },
        {
          form: '10-Q',
          filing_date: '2026-07-31',
          report_date: '2026-06-27',
          accession_number: '0000320193-26-000020',
          primary_document: 'quarterly_report.htm',
          description: 'Quarterly Report for period ended June 27, 2026',
          url: 'https://www.sec.gov/edgar/browse/?CIK=0000320193',
          is_xbrl: true,
        },
        {
          form: '8-K',
          filing_date: '2026-08-15',
          report_date: '2026-08-15',
          accession_number: '0000320193-26-000025',
          primary_document: 'current_event.htm',
          description: 'Item 2.02: Results of Operations and Financial Condition',
          url: 'https://www.sec.gov/edgar/browse/?CIK=0000320193',
          is_xbrl: false,
        },
      ],
    }
  }

  try {
    return await requestJson<SecFilingsResponse>(url, config)
  } catch {
    return {
      ticker: clean,
      cik: '0000320193',
      company_name: clean,
      filings: [],
    }
  }
}

// --------------------------------------------------------------------------
// Options & Black-Scholes API
// --------------------------------------------------------------------------

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

export async function getOptionChain(
  config: DataConfig,
  ticker: string,
  expiry?: string,
): Promise<OptionChainResponse> {
  const clean = ticker.trim().toUpperCase()
  const expParam = expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''
  const url = apiUrl(config, `/api/v1/options/chain?ticker=${encodeURIComponent(clean)}${expParam}`)

  if (config.source === 'snapshot') {
    const basePrice = clean === 'AAPL' ? 230 : clean === 'NVDA' ? 135 : 150
    const expirations = ['2026-11-20', '2026-12-18', '2027-01-15', '2027-03-19']
    const selExp = expiry || expirations[0]
    const strikes = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15].map((mult) => Math.round(basePrice * mult))

    return {
      ticker: clean,
      underlying_price: basePrice,
      expirations,
      selected_expiration: selExp,
      calls: strikes.map((k) => ({
        contract_symbol: `${clean}C${k}`,
        strike: k,
        last_price: Number(Math.max(0.5, (basePrice - k) + 5).toFixed(2)),
        bid: Number(Math.max(0.4, (basePrice - k) + 4.8).toFixed(2)),
        ask: Number(Math.max(0.6, (basePrice - k) + 5.2).toFixed(2)),
        volume: 240,
        open_interest: 1100,
        implied_volatility: 0.26,
        in_the_money: k < basePrice,
        delta: Number((k < basePrice ? 0.72 : 0.28).toFixed(2)),
        gamma: 0.02,
        vega: 0.32,
        theta: -0.06,
      })),
      puts: strikes.map((k) => ({
        contract_symbol: `${clean}P${k}`,
        strike: k,
        last_price: Number(Math.max(0.5, (k - basePrice) + 5).toFixed(2)),
        bid: Number(Math.max(0.4, (k - basePrice) + 4.8).toFixed(2)),
        ask: Number(Math.max(0.6, (k - basePrice) + 5.2).toFixed(2)),
        volume: 180,
        open_interest: 850,
        implied_volatility: 0.26,
        in_the_money: k > basePrice,
        delta: Number((k > basePrice ? -0.72 : -0.28).toFixed(2)),
        gamma: 0.02,
        vega: 0.32,
        theta: -0.05,
      })),
    }
  }

  return requestJson<OptionChainResponse>(url, config)
}

export async function calculateOption(
  config: DataConfig,
  input: BlackScholesInput,
): Promise<BlackScholesOutput> {
  if (config.source === 'snapshot') {
    // Client-side analytical fallback
    const S = input.underlying_price
    const K = input.strike_price
    const T = Math.max(1e-4, input.dte / 365)
    const sigma = Math.max(1e-4, input.volatility_pct / 100)
    const r = Math.max(0, input.risk_free_rate_pct / 100)
    const q = Math.max(0, input.dividend_yield_pct / 100)

    const sqrtT = Math.sqrt(T)
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    const d2 = d1 - sigma * sqrtT

    const dfR = Math.exp(-r * T)
    const dfQ = Math.exp(-q * T)
    const nd1 = normalCdf(d1)
    const nd2 = normalCdf(d2)
    const nNegD1 = normalCdf(-d1)
    const nNegD2 = normalCdf(-d2)
    const pdfD1 = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI)

    const callPrice = Math.max(0, S * dfQ * nd1 - K * dfR * nd2)
    const putPrice = Math.max(0, K * dfR * nNegD2 - S * dfQ * nNegD1)

    const callDelta = dfQ * nd1
    const putDelta = dfQ * (nd1 - 1)
    const gamma = (dfQ * pdfD1) / (S * sigma * sqrtT)
    const vega = S * dfQ * sqrtT * pdfD1 * 0.01
    const callTheta = (-(S * dfQ * pdfD1 * sigma) / (2 * sqrtT) - r * K * dfR * nd2 + q * S * dfQ * nd1) / 365
    const putTheta = (-(S * dfQ * pdfD1 * sigma) / (2 * sqrtT) + r * K * dfR * nNegD2 - q * S * dfQ * nNegD1) / 365
    const callRho = K * T * dfR * nd2 * 0.01
    const putRho = -K * T * dfR * nNegD2 * 0.01

    const payoffCurve = []
    const minP = Math.max(1, S * 0.7)
    const maxP = S * 1.3
    const steps = 25
    for (let i = 0; i < steps; i++) {
      const p = minP + (i / (steps - 1)) * (maxP - minP)
      payoffCurve.push({
        underlying_price: Number(p.toFixed(2)),
        call_payoff: Number((Math.max(0, p - K) - callPrice).toFixed(2)),
        put_payoff: Number((Math.max(0, K - p) - putPrice).toFixed(2)),
      })
    }

    return {
      call_price: Number(callPrice.toFixed(2)),
      put_price: Number(putPrice.toFixed(2)),
      call_greeks: {
        delta: Number(callDelta.toFixed(4)),
        gamma: Number(gamma.toFixed(4)),
        vega: Number(vega.toFixed(4)),
        theta: Number(callTheta.toFixed(4)),
        rho: Number(callRho.toFixed(4)),
      },
      put_greeks: {
        delta: Number(putDelta.toFixed(4)),
        gamma: Number(gamma.toFixed(4)),
        vega: Number(vega.toFixed(4)),
        theta: Number(putTheta.toFixed(4)),
        rho: Number(putRho.toFixed(4)),
      },
      call_intrinsic: Number(Math.max(0, S - K).toFixed(2)),
      call_time_value: Number(Math.max(0, callPrice - Math.max(0, S - K)).toFixed(2)),
      put_intrinsic: Number(Math.max(0, K - S).toFixed(2)),
      put_time_value: Number(Math.max(0, putPrice - Math.max(0, K - S)).toFixed(2)),
      payoff_curve: payoffCurve,
    }
  }

  return requestJson<BlackScholesOutput>(apiUrl(config, '/api/v1/options/calculator'), config, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
