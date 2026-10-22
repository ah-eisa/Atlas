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
  AttributionGroupBy,
  AttributionPeriod,
  AttributionReport,
  BlackScholesInput,
  BlackScholesOutput,
  BondCalculatorInput,
  BondCalculatorOutput,
  BootstrapResponse,
  CashFlow,
  CsvImportCommitResult,
  CsvImportPreview,
  DataSource,
  FactsheetReport,
  HistoricalYieldPoint,
  InstrumentInfo,
  MacroHistoryPoint,
  MacroSummaryResponse,
  MarketTickerResponse,
  OptionChainResponse,
  OrderInput,
  Portfolio,
  PortfolioState,
  Position,
  PositionInput,
  RealizedPnlSummary,
  SecFilingsResponse,
  Snapshot,
  StressReport,
  StressShock,
  Transaction,
  WatchlistItem,
  WatchlistResponse,
  XRayReport,
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

// --------------------------------------------------------------------------
// Portfolio Lab: X-Ray, Stress Lab & Brinson Attribution API
// --------------------------------------------------------------------------

const SAMPLE_XRAY_REPORT: XRayReport = {
  as_of: '2026-04-06',
  total_value: 254180.5,
  positions: 8,
  headline: {
    effective_holdings: 5.82,
    herfindahl: 0.1718,
    largest_pct: 0.245,
    top_five_pct: 0.784,
    diversification_ratio: 1.42,
  },
  findings: [
    {
      severity: 'medium',
      code: 'single_position',
      message: 'VWCE.DE is 25% of the portfolio.',
    },
    {
      severity: 'medium',
      code: 'risk_hog',
      message: 'BTC-USD is 12% of capital but 34% of portfolio volatility.',
    },
    {
      severity: 'medium',
      code: 'overlap',
      message: 'VWCE.DE, AAPL, MSFT move together (correlation >= 0.80) and are 52% of the portfolio combined.',
    },
  ],
  exposure: {
    asset_class: [
      { key: 'ETF', weight: 0.48 },
      { key: 'Stock', weight: 0.32 },
      { key: 'Crypto', weight: 0.12 },
      { key: 'Bond', weight: 0.08 },
    ],
    region: [
      { key: 'US', weight: 0.54 },
      { key: 'Global', weight: 0.25 },
      { key: 'Europe', weight: 0.21 },
    ],
    currency: [
      { key: 'USD', weight: 0.56 },
      { key: 'EUR', weight: 0.44 },
    ],
  },
  risk_vs_capital: [
    { ticker: 'BTC-USD', weight: 0.12, risk_share: 0.34, risk_to_weight: 2.8333 },
    { ticker: 'VWCE.DE', weight: 0.245, risk_share: 0.22, risk_to_weight: 0.898 },
    { ticker: 'NVDA', weight: 0.14, risk_share: 0.19, risk_to_weight: 1.3571 },
    { ticker: 'AAPL', weight: 0.135, risk_share: 0.12, risk_to_weight: 0.8889 },
    { ticker: 'MSFT', weight: 0.14, risk_share: 0.09, risk_to_weight: 0.6429 },
    { ticker: 'AGGH.AS', weight: 0.08, risk_share: 0.02, risk_to_weight: 0.25 },
  ],
  overlap: {
    pairs: [
      { a: 'AAPL', b: 'MSFT', correlation: 0.84 },
      { a: 'VWCE.DE', b: 'AAPL', correlation: 0.81 },
    ],
    clusters: [{ tickers: ['VWCE.DE', 'AAPL', 'MSFT'], combined_weight: 0.52 }],
    threshold: 0.8,
  },
  methodology:
    'Overlap is statistical, inferred from daily return correlation. It does not look through ETF or fund holdings.',
}

const SAMPLE_STRESS_REPORT: StressReport = {
  as_of: '2026-04-06',
  base_currency: 'EUR',
  total_value: 254180.5,
  benchmark: 'S&P 500',
  betas: {
    'VWCE.DE': 0.94,
    AAPL: 1.15,
    MSFT: 1.08,
    NVDA: 1.65,
    'BTC-USD': 1.85,
    'AGGH.AS': 0.12,
  },
  methodology:
    'First-order factor model. Each position has one primary factor (equity beta, bond duration, gold, crypto) plus a currency effect.',
  results: [
    {
      key: 'gfc_2008',
      name: '2008 financial crisis',
      description: 'Global equities halve, flight to quality cuts Treasury yields and lifts the dollar and gold.',
      window: 'Sep 2008 - Mar 2009',
      kind: 'historical',
      shock: { equity_pct: -0.5, rates_bps: -200, usd_pct: 0.12, gold_pct: 0.1, crypto_pct: -0.6 },
      value_before: 254180.5,
      value_after: 158420.1,
      pnl: -95760.4,
      pnl_pct: -0.3767,
      fx_pnl: 8420.0,
      by_factor: [
        { key: 'equity', pnl: -82100.4, pct_of_portfolio: -0.323 },
        { key: 'crypto', pnl: -16400.0, pct_of_portfolio: -0.0645 },
        { key: 'rates', pnl: 2740.0, pct_of_portfolio: 0.0108 },
      ],
      by_asset_class: [
        { key: 'ETF', pnl: -46200.0, pct_of_portfolio: -0.1818 },
        { key: 'Stock', pnl: -35900.4, pct_of_portfolio: -0.1412 },
        { key: 'Crypto', pnl: -16400.0, pct_of_portfolio: -0.0645 },
        { key: 'Bond', pnl: 2740.0, pct_of_portfolio: 0.0108 },
      ],
      positions: [
        {
          ticker: 'VWCE.DE',
          name: 'Vanguard FTSE All-World',
          asset_class: 'ETF',
          factor: 'equity',
          weight: 0.245,
          sensitivity: 0.94,
          price_move_pct: -0.47,
          fx_move_pct: 0,
          total_move_pct: -0.47,
          pnl: -29268.0,
        },
        {
          ticker: 'NVDA',
          name: 'NVIDIA Corp',
          asset_class: 'Stock',
          factor: 'equity',
          weight: 0.14,
          sensitivity: 1.65,
          price_move_pct: -0.825,
          fx_move_pct: 0.12,
          total_move_pct: -0.804,
          pnl: -28610.5,
        },
        {
          ticker: 'BTC-USD',
          name: 'Bitcoin',
          asset_class: 'Crypto',
          factor: 'crypto',
          weight: 0.12,
          sensitivity: 1.0,
          price_move_pct: -0.6,
          fx_move_pct: 0.12,
          total_move_pct: -0.552,
          pnl: -16400.0,
        },
      ],
    },
    {
      key: 'covid_2020',
      name: '2020 COVID-19 crash',
      description: 'Five-week dash for cash in February and March 2020.',
      window: 'Feb - Mar 2020',
      kind: 'historical',
      shock: { equity_pct: -0.34, rates_bps: -120, usd_pct: 0.06, gold_pct: 0.03, crypto_pct: -0.5 },
      value_before: 254180.5,
      value_after: 185920.0,
      pnl: -68260.5,
      pnl_pct: -0.2685,
      fx_pnl: 4910.0,
      by_factor: [
        { key: 'equity', pnl: -55820.5, pct_of_portfolio: -0.2196 },
        { key: 'crypto', pnl: -14100.0, pct_of_portfolio: -0.0555 },
        { key: 'rates', pnl: 1660.0, pct_of_portfolio: 0.0065 },
      ],
      by_asset_class: [
        { key: 'ETF', pnl: -31200.0, pct_of_portfolio: -0.1227 },
        { key: 'Stock', pnl: -24620.5, pct_of_portfolio: -0.0969 },
        { key: 'Crypto', pnl: -14100.0, pct_of_portfolio: -0.0555 },
        { key: 'Bond', pnl: 1660.0, pct_of_portfolio: 0.0065 },
      ],
      positions: [],
    },
    {
      key: 'rates_2022',
      name: '2022 rate shock',
      description: 'Central banks hike ~300 bps; stocks and bonds fall together while the dollar rallies.',
      window: 'Jan - Oct 2022',
      kind: 'historical',
      shock: { equity_pct: -0.25, rates_bps: 250, usd_pct: 0.12, gold_pct: -0.05, crypto_pct: -0.65 },
      value_before: 254180.5,
      value_after: 196110.5,
      pnl: -58070.0,
      pnl_pct: -0.2285,
      fx_pnl: 9800.0,
      by_factor: [
        { key: 'equity', pnl: -36920.0, pct_of_portfolio: -0.1453 },
        { key: 'crypto', pnl: -17730.0, pct_of_portfolio: -0.0698 },
        { key: 'rates', pnl: -3420.0, pct_of_portfolio: -0.0135 },
      ],
      by_asset_class: [],
      positions: [],
    },
    {
      key: 'rates_up_100',
      name: 'Rates +100 bps',
      description: 'Parallel 100 bps upward shift in yields with a modest equity derating.',
      window: 'Instant shock',
      kind: 'parametric',
      shock: { equity_pct: -0.05, rates_bps: 100, usd_pct: 0.02, gold_pct: -0.02, crypto_pct: -0.1 },
      value_before: 254180.5,
      value_after: 242310.0,
      pnl: -11870.5,
      pnl_pct: -0.0467,
      fx_pnl: 2150.0,
      by_factor: [
        { key: 'equity', pnl: -8100.5, pct_of_portfolio: -0.0319 },
        { key: 'crypto', pnl: -2400.0, pct_of_portfolio: -0.0094 },
        { key: 'rates', pnl: -1370.0, pct_of_portfolio: -0.0054 },
      ],
      by_asset_class: [],
      positions: [],
    },
  ],
}

const SAMPLE_ATTRIBUTION_REPORT: AttributionReport = {
  as_of: '2026-04-06',
  period: 'all',
  group_by: 'asset_class',
  start_date: '2025-01-02',
  end_date: '2026-04-06',
  benchmark_mode: 'equal_weight',
  benchmark_label: 'Equal-weight opportunity set',
  excluded: [],
  time_weighted_return_pct: 0.1842,
  basis:
    'Single-period buy-and-hold from the window start, using the positions held on that date.',
  totals: {
    portfolio_return_pct: 0.1842,
    benchmark_return_pct: 0.141,
    active_return_pct: 0.0432,
    allocation_pct: 0.0245,
    selection_pct: 0.0132,
    interaction_pct: 0.0055,
    residual_pct: 0.0,
    weights_normalised: false,
  },
  segments: [
    {
      key: 'Stock',
      portfolio_weight: 0.32,
      benchmark_weight: 0.25,
      portfolio_return_pct: 0.264,
      benchmark_return_pct: 0.215,
      allocation_pct: 0.0052,
      selection_pct: 0.0123,
      interaction_pct: 0.0034,
      total_pct: 0.0209,
    },
    {
      key: 'ETF',
      portfolio_weight: 0.48,
      benchmark_weight: 0.25,
      portfolio_return_pct: 0.162,
      benchmark_return_pct: 0.155,
      allocation_pct: 0.0032,
      selection_pct: 0.0018,
      interaction_pct: 0.0016,
      total_pct: 0.0066,
    },
    {
      key: 'Bond',
      portfolio_weight: 0.08,
      benchmark_weight: 0.25,
      portfolio_return_pct: 0.028,
      benchmark_return_pct: 0.032,
      allocation_pct: 0.0185,
      selection_pct: -0.001,
      interaction_pct: 0.0007,
      total_pct: 0.0182,
    },
    {
      key: 'Crypto',
      portfolio_weight: 0.12,
      benchmark_weight: 0.25,
      portfolio_return_pct: 0.161,
      benchmark_return_pct: 0.162,
      allocation_pct: -0.0024,
      selection_pct: 0.0001,
      interaction_pct: -0.0002,
      total_pct: -0.0025,
    },
  ],
}

export async function getPortfolioXRay(
  config: DataConfig,
  portfolioId: number = getStoredPortfolioId(),
): Promise<XRayReport> {
  if (config.source === 'snapshot') {
    return SAMPLE_XRAY_REPORT
  }
  try {
    return await requestJson<XRayReport>(
      apiUrl(config, `/api/v1/portfolio/xray?portfolio_id=${portfolioId}`),
      config,
    )
  } catch {
    return SAMPLE_XRAY_REPORT
  }
}

export async function getStressReport(
  config: DataConfig,
  portfolioId: number = getStoredPortfolioId(),
): Promise<StressReport> {
  if (config.source === 'snapshot') {
    return SAMPLE_STRESS_REPORT
  }
  try {
    return await requestJson<StressReport>(
      apiUrl(config, `/api/v1/portfolio/stress?portfolio_id=${portfolioId}`),
      config,
    )
  } catch {
    return SAMPLE_STRESS_REPORT
  }
}

export async function runCustomStress(
  config: DataConfig,
  custom: StressShock,
  portfolioId: number = getStoredPortfolioId(),
): Promise<StressReport> {
  if (config.source === 'snapshot') {
    const val = SAMPLE_STRESS_REPORT.total_value
    const move =
      0.75 * custom.equity_pct +
      0.08 * (-6.5 * (custom.rates_bps / 10000)) +
      0.12 * custom.crypto_pct +
      0.05 * custom.gold_pct +
      0.45 * custom.usd_pct
    const pnl = Number((val * move).toFixed(2))
    return {
      ...SAMPLE_STRESS_REPORT,
      results: [
        {
          key: 'custom',
          name: 'Custom scenario',
          description: 'User-defined simultaneous shocks.',
          window: 'Instant shock',
          kind: 'custom',
          shock: custom,
          value_before: val,
          value_after: Number((val + pnl).toFixed(2)),
          pnl,
          pnl_pct: Number(move.toFixed(4)),
          fx_pnl: Number((val * 0.45 * custom.usd_pct).toFixed(2)),
          by_factor: [
            { key: 'equity', pnl: Number((val * 0.75 * custom.equity_pct).toFixed(2)), pct_of_portfolio: Number((0.75 * custom.equity_pct).toFixed(4)) },
            { key: 'crypto', pnl: Number((val * 0.12 * custom.crypto_pct).toFixed(2)), pct_of_portfolio: Number((0.12 * custom.crypto_pct).toFixed(4)) },
            { key: 'rates', pnl: Number((val * 0.08 * (-6.5 * (custom.rates_bps / 10000))).toFixed(2)), pct_of_portfolio: Number((0.08 * (-6.5 * (custom.rates_bps / 10000))).toFixed(4)) },
          ],
          by_asset_class: [],
          positions: SAMPLE_STRESS_REPORT.results[0].positions.map((pos) => {
            const pMove =
              pos.factor === 'equity'
                ? pos.sensitivity * custom.equity_pct
                : pos.factor === 'crypto'
                  ? custom.crypto_pct
                  : -6.5 * (custom.rates_bps / 10000)
            const pVal = val * pos.weight
            return {
              ...pos,
              price_move_pct: Number(pMove.toFixed(4)),
              fx_move_pct: Number(custom.usd_pct.toFixed(4)),
              total_move_pct: Number((pMove + custom.usd_pct * 0.5).toFixed(4)),
              pnl: Number((pVal * (pMove + custom.usd_pct * 0.5)).toFixed(2)),
            }
          }),
        },
        ...SAMPLE_STRESS_REPORT.results,
      ],
    }
  }
  return requestJson<StressReport>(
    apiUrl(config, `/api/v1/portfolio/stress?portfolio_id=${portfolioId}`),
    config,
    {
      method: 'POST',
      body: JSON.stringify({
        scenarios: ['gfc_2008', 'covid_2020', 'rates_2022', 'rates_up_100', 'rates_down_100', 'equity_down_20', 'usd_up_10'],
        custom,
      }),
    },
  )
}

export async function getAttributionReport(
  config: DataConfig,
  period: AttributionPeriod = 'all',
  groupBy: AttributionGroupBy = 'asset_class',
  portfolioId: number = getStoredPortfolioId(),
): Promise<AttributionReport> {
  if (config.source === 'snapshot') {
    return {
      ...SAMPLE_ATTRIBUTION_REPORT,
      period,
      group_by: groupBy,
    }
  }
  try {
    return await requestJson<AttributionReport>(
      apiUrl(
        config,
        `/api/v1/portfolio/attribution?period=${encodeURIComponent(period)}&group_by=${encodeURIComponent(groupBy)}&portfolio_id=${portfolioId}`,
      ),
      config,
    )
  } catch {
    return {
      ...SAMPLE_ATTRIBUTION_REPORT,
      period,
      group_by: groupBy,
    }
  }
}

const SAMPLE_FACTSHEET_REPORT: FactsheetReport = {
  as_of: '2026-04-06',
  generated_at: '2026-04-06T16:00:00Z',
  portfolio_name: 'Global Multi-Asset Mandate',
  base_currency: 'EUR',
  benchmark: 'S&P 500',
  kpis: {
    total_value: 254180.5,
    total_cost: 214500.0,
    unrealized_pnl: 39680.5,
    unrealized_pnl_pct: 0.185,
    realized_pnl: 6420.0,
    win_rate_pct: 66.67,
    twr_pct: 0.1842,
    mwr_pct: 0.1795,
    benchmark_return_pct: 0.141,
    active_return_pct: 0.0432,
    annualized_vol_pct: 0.142,
    sharpe: 1.18,
    sortino: 1.64,
    max_drawdown_pct: -0.094,
    var_95_pct: -0.0145,
    cvar_95_pct: -0.021,
    effective_holdings: 5.82,
    top_five_pct: 0.784,
    diversification_ratio: 1.42,
  },
  narrative: {
    mandate_overview:
      'Global Multi-Asset Mandate (EUR) holds 8 active positions with a total Net Asset Value of 254,180.50 EUR against a cost basis of 214,500.00 EUR (Unrealised P&L: +39,680.50 EUR, +18.50%).',
    performance_drivers:
      'Since inception, the book delivered a Time-Weighted Return (TWR) of +18.42% versus +14.10% for S&P 500 (Active Return: +4.32%). Brinson-Fachler attribution indicates that Stock was the primary active driver (+2.09% total active contribution: +0.52% allocation, +1.23% selection).',
    risk_and_concentration:
      'Annualised volatility stands at 14.20% with a Sharpe ratio of 1.18 and historical maximum drawdown of -9.40%. Effective holdings (1/HHI) equal 5.82 across 8 positions, with top-5 concentration at 78.4%.',
    stress_resilience:
      'Across historical crisis replays, the severest modeled shock is 2008 financial crisis (Sep 2008 - Mar 2009), projecting an estimated drawdown of -37.67% (-95,760.40 EUR).',
  },
  top_holdings: [
    {
      ticker: 'VWCE.DE',
      name: 'Vanguard FTSE All-World',
      asset_class: 'ETF',
      region: 'Global',
      currency: 'EUR',
      weight: 0.245,
      value_base: 62274.22,
      unrealized_pnl: 9850.0,
      unrealized_pnl_pct: 0.1879,
    },
    {
      ticker: 'NVDA',
      name: 'NVIDIA Corp',
      asset_class: 'Stock',
      region: 'US',
      currency: 'USD',
      weight: 0.14,
      value_base: 35585.27,
      unrealized_pnl: 11240.0,
      unrealized_pnl_pct: 0.4617,
    },
    {
      ticker: 'MSFT',
      name: 'Microsoft Corp',
      asset_class: 'Stock',
      region: 'US',
      currency: 'USD',
      weight: 0.14,
      value_base: 35585.27,
      unrealized_pnl: 6420.0,
      unrealized_pnl_pct: 0.2201,
    },
    {
      ticker: 'AAPL',
      name: 'Apple Inc',
      asset_class: 'Stock',
      region: 'US',
      currency: 'USD',
      weight: 0.135,
      value_base: 34314.37,
      unrealized_pnl: 5110.0,
      unrealized_pnl_pct: 0.175,
    },
    {
      ticker: 'BTC-USD',
      name: 'Bitcoin',
      asset_class: 'Crypto',
      region: 'Global',
      currency: 'USD',
      weight: 0.12,
      value_base: 30501.66,
      unrealized_pnl: 6200.5,
      unrealized_pnl_pct: 0.2551,
    },
    {
      ticker: 'AGGH.AS',
      name: 'iShares Global Aggregate Bond',
      asset_class: 'Bond',
      region: 'Global',
      currency: 'EUR',
      weight: 0.08,
      value_base: 20334.44,
      unrealized_pnl: 860.0,
      unrealized_pnl_pct: 0.0442,
    },
  ],
  xray_findings: SAMPLE_XRAY_REPORT.findings,
  exposure: SAMPLE_XRAY_REPORT.exposure,
  attribution_totals: SAMPLE_ATTRIBUTION_REPORT.totals,
  attribution_segments: SAMPLE_ATTRIBUTION_REPORT.segments,
  stress_highlights: SAMPLE_STRESS_REPORT.results.map((r) => ({
    key: r.key,
    name: r.name,
    window: r.window,
    pnl: r.pnl,
    pnl_pct: r.pnl_pct,
    value_after: r.value_after,
  })),
  markdown_memo: [
    '# INVESTMENT COMMITTEE MEMO & FACTSHEET — GLOBAL MULTI-ASSET MANDATE',
    '**As of Date:** 2026-04-06 | **Base Currency:** EUR | **Benchmark:** S&P 500',
    '',
    '## 1. Executive Mandate Summary',
    '- **Net Asset Value (NAV):** 254,180.50 EUR',
    '- **Total Cost Basis:** 214,500.00 EUR',
    '- **Unrealised P&L:** +39,680.50 EUR (+18.50%)',
    '- **Time-Weighted Return (TWR):** +18.42% (vs Benchmark +14.10%, Active +4.32%)',
  ].join('\n'),
}

export async function getPortfolioReport(
  config: DataConfig,
  portfolioId: number = getStoredPortfolioId(),
): Promise<FactsheetReport> {
  if (config.source === 'snapshot') {
    return SAMPLE_FACTSHEET_REPORT
  }
  try {
    return await requestJson<FactsheetReport>(
      apiUrl(config, `/api/v1/portfolio/report?portfolio_id=${portfolioId}`),
      config,
    )
  } catch {
    return SAMPLE_FACTSHEET_REPORT
  }
}

// --------------------------------------------------------------------------
// CSV Import Wizard & Watchlist + Smart Alerts API
// --------------------------------------------------------------------------

export async function previewCsvImport(
  config: DataConfig,
  csvText: string,
  mappingOverrides?: Record<string, string>,
): Promise<CsvImportPreview> {
  if (config.source === 'snapshot') {
    return {
      detected_format: 'generic_positions',
      delimiter: ',',
      headers: ['ticker', 'name', 'asset_class', 'quantity', 'cost_basis_per_unit'],
      mapping: {
        ticker: 'ticker',
        name: 'name',
        asset_class: 'asset_class',
        quantity: 'quantity',
        cost_basis_per_unit: 'cost_basis_per_unit',
      },
      positions: [
        {
          ticker: 'MSFT',
          name: 'Microsoft Corp',
          asset_class: 'Stock',
          region: 'US',
          currency: 'USD',
          quantity: 20,
          cost_basis_per_unit: 420.0,
          acquired: '2025-01-15',
        },
      ],
      trades: [],
      cash_flows: [],
      warnings: [],
      errors: [],
      summary: { positions_count: 1, trades_count: 0, cash_flows_count: 0 },
    }
  }

  return requestJson<CsvImportPreview>(apiUrl(config, '/api/v1/portfolio/import/preview'), config, {
    method: 'POST',
    body: JSON.stringify({
      csv_text: csvText,
      mapping_overrides: mappingOverrides,
    }),
  })
}

export async function commitCsvImport(
  config: DataConfig,
  csvText: string,
  mode: 'merge' | 'replace' = 'merge',
  mappingOverrides?: Record<string, string>,
): Promise<CsvImportCommitResult> {
  if (config.source === 'snapshot') {
    return {
      detected_format: 'generic_positions',
      mode,
      imported_positions: 1,
      imported_trades: 0,
      imported_cash_flows: 0,
      warnings: ['Snapshot demo mode: database not modified.'],
    }
  }

  return requestJson<CsvImportCommitResult>(apiUrl(config, '/api/v1/portfolio/import/commit'), config, {
    method: 'POST',
    body: JSON.stringify({
      csv_text: csvText,
      mode,
      mapping_overrides: mappingOverrides,
    }),
  })
}

const SAMPLE_WATCHLIST: WatchlistResponse = {
  watchlist: [
    {
      id: 1,
      portfolio_id: 1,
      ticker: 'NVDA',
      name: 'NVIDIA Corp.',
      target_buy_price: 130.0,
      target_sell_price: 165.0,
      notes: 'AI datacenter GPU leader — watch Q3 10-Q margins',
      created_at: '2026-01-10T10:00:00Z',
      last_price: 138.4,
      currency: 'USD',
      asset_class: 'Stock',
      in_portfolio: true,
      portfolio_weight: 0.14,
      status: 'WATCHING',
      distance_to_buy_pct: 0.0646,
      distance_to_sell_pct: 0.1922,
    },
    {
      id: 2,
      portfolio_id: 1,
      ticker: 'MSFT',
      name: 'Microsoft Corp.',
      target_buy_price: 450.0,
      target_sell_price: 520.0,
      notes: 'Core enterprise cloud & software compounder',
      created_at: '2026-01-10T10:00:00Z',
      last_price: 445.2,
      currency: 'USD',
      asset_class: 'Stock',
      in_portfolio: true,
      portfolio_weight: 0.14,
      status: 'BUY_ZONE',
      distance_to_buy_pct: -0.0107,
      distance_to_sell_pct: 0.168,
    },
    {
      id: 3,
      portfolio_id: 1,
      ticker: 'TSLA',
      name: 'Tesla Inc.',
      target_buy_price: 220.0,
      target_sell_price: 280.0,
      notes: 'Autonomous tech & energy storage catalysts',
      created_at: '2026-02-15T12:00:00Z',
      last_price: 258.3,
      currency: 'USD',
      asset_class: 'Stock',
      in_portfolio: false,
      portfolio_weight: 0.0,
      status: 'WATCHING',
      distance_to_buy_pct: 0.1741,
      distance_to_sell_pct: 0.084,
    },
  ],
  rules: [
    {
      id: 1,
      portfolio_id: 1,
      metric: 'drawdown_pct',
      ticker: null,
      threshold: -10.0,
      label: 'Portfolio Drawdown <= -10%',
      enabled: true,
      created_at: '2026-01-02T00:00:00Z',
    },
    {
      id: 2,
      portfolio_id: 1,
      metric: 'price_below',
      ticker: 'MSFT',
      threshold: 450.0,
      label: 'MSFT <= $450 Buy Alert',
      enabled: true,
      created_at: '2026-01-02T00:00:00Z',
    },
  ],
  triggered_alerts: [
    {
      id: 'wl-buy-MSFT',
      severity: 'high',
      category: 'Watchlist Target',
      ticker: 'MSFT',
      title: 'MSFT reached Target Buy Zone ($445.20 <= $450.00)',
      message: 'MSFT is trading at 445.20 USD, breaking below your target buy price of 450.00 USD.',
    },
    {
      id: 'macro-yc-inv',
      severity: 'high',
      category: 'Macro & Rates',
      ticker: 'US10Y-2Y',
      title: 'US Treasury 10Y-2Y Inversion In Effect',
      message: '10Y Treasury yield trades below 2Y yield, signaling institutional macro warning.',
    },
  ],
}

export async function getWatchlistAndAlerts(
  config: DataConfig,
  portfolioId: number = getStoredPortfolioId(),
): Promise<WatchlistResponse> {
  if (config.source === 'snapshot') {
    return SAMPLE_WATCHLIST
  }
  try {
    return await requestJson<WatchlistResponse>(
      apiUrl(config, `/api/v1/watchlist?portfolio_id=${portfolioId}`),
      config,
    )
  } catch {
    return SAMPLE_WATCHLIST
  }
}

export async function addWatchlistItem(
  config: DataConfig,
  item: {
    ticker: string
    name?: string
    target_buy_price?: number | null
    target_sell_price?: number | null
    notes?: string
  },
  portfolioId: number = getStoredPortfolioId(),
): Promise<WatchlistItem> {
  if (config.source === 'snapshot') {
    return {
      id: Date.now(),
      portfolio_id: portfolioId,
      ticker: item.ticker.toUpperCase(),
      name: item.name || item.ticker.toUpperCase(),
      target_buy_price: item.target_buy_price ?? null,
      target_sell_price: item.target_sell_price ?? null,
      notes: item.notes || '',
      created_at: new Date().toISOString(),
      last_price: 150.0,
      currency: 'USD',
      asset_class: 'Stock',
      in_portfolio: false,
      portfolio_weight: 0.0,
      status: 'WATCHING',
      distance_to_buy_pct: null,
      distance_to_sell_pct: null,
    }
  }

  return requestJson<WatchlistItem>(
    apiUrl(config, `/api/v1/watchlist?portfolio_id=${portfolioId}`),
    config,
    {
      method: 'POST',
      body: JSON.stringify(item),
    },
  )
}

export async function deleteWatchlistItem(
  config: DataConfig,
  itemId: number,
  portfolioId: number = getStoredPortfolioId(),
): Promise<void> {
  if (config.source === 'snapshot') return
  await fetch(apiUrl(config, `/api/v1/watchlist/${itemId}?portfolio_id=${portfolioId}`), {
    method: 'DELETE',
    headers: config.apiKey ? { 'X-API-Key': config.apiKey } : undefined,
  })
}

export async function addAlertRule(
  config: DataConfig,
  rule: {
    metric: string
    ticker?: string | null
    threshold: number
    label?: string
  },
  portfolioId: number = getStoredPortfolioId(),
): Promise<void> {
  if (config.source === 'snapshot') return
  await requestJson(apiUrl(config, `/api/v1/alerts/rules?portfolio_id=${portfolioId}`), config, {
    method: 'POST',
    body: JSON.stringify(rule),
  })
}

export async function deleteAlertRule(
  config: DataConfig,
  ruleId: number,
  portfolioId: number = getStoredPortfolioId(),
): Promise<void> {
  if (config.source === 'snapshot') return
  await fetch(apiUrl(config, `/api/v1/alerts/rules/${ruleId}?portfolio_id=${portfolioId}`), {
    method: 'DELETE',
    headers: config.apiKey ? { 'X-API-Key': config.apiKey } : undefined,
  })
}

const DEFAULT_MARKET_TICKER: MarketTickerResponse = {
  as_of: '2026-10-22',
  quotes: [
    { symbol: 'S&P 500', name: 'US Large Cap', price: '7,645.18', change: '-110.93', pct: '-1.43%', isPositive: false },
    { symbol: 'NASDAQ', name: 'US Tech', price: '25,970.17', change: '-732.69', pct: '-2.74%', isPositive: false },
    { symbol: 'BTC-USD', name: 'Bitcoin', price: '$81,114', change: '-2,885.62', pct: '-3.43%', isPositive: false },
    { symbol: 'GOLD', name: 'Gold Spot', price: '$4,054.60', change: '-96.50', pct: '-2.33%', isPositive: false },
    { symbol: 'US 10Y', name: 'Treasury Yield', price: '4.96%', change: '-0.19', pct: '-3.67%', isPositive: false },
    { symbol: 'CRUDE OIL', name: 'WTI Crude', price: '$99.27', change: '-2.51', pct: '-2.47%', isPositive: false },
    { symbol: 'EUR/USD', name: 'Euro / USD', price: '1.1226', change: '-0.0001', pct: '-0.01%', isPositive: false },
  ],
}

export async function getMarketTicker(config: DataConfig): Promise<MarketTickerResponse> {
  if (config.source === 'snapshot') {
    return DEFAULT_MARKET_TICKER
  }
  try {
    return await requestJson<MarketTickerResponse>(apiUrl(config, '/api/v1/market/ticker'), config)
  } catch (err) {
    console.warn('Failed to fetch live market ticker, falling back to cached snapshot quotes:', err)
    return DEFAULT_MARKET_TICKER
  }
}




