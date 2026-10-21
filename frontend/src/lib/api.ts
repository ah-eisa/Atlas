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
  BootstrapResponse,
  CashFlow,
  DataSource,
  InstrumentInfo,
  Portfolio,
  PortfolioState,
  Position,
  PositionInput,
  Snapshot,
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
