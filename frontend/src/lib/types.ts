/**
 * TypeScript mirror of the backend JSON contract (see API.md).
 *
 * Unit conventions, identical on every endpoint:
 *   - Money is in the base currency, rounded to 2 dp.
 *   - Any field ending in `_pct` is a **fraction**: 0.1234 means 12.34%.
 *   - Ratios (Sharpe, Sortino, beta, correlation) are unitless, 4 dp.
 *   - Dates are ISO `YYYY-MM-DD` strings.
 *
 * Values the backend cannot compute serialise as `null` (never NaN), so
 * nullable fields are typed as such rather than being silently trusted.
 */

/** Fields present on every analytic payload, making each response self-describing. */
export interface Envelope {
  as_of: string
  base_currency: string
  generated_at: string
}

export interface Health extends Envelope {
  status: string
  version: string
  holdings_count: number
  benchmark: string
  history_start: string
  history_days: number
  prices_fetched_at: string
  observations: number
  warnings: string[]
}

export interface Holding {
  ticker: string
  name: string
  asset_class: string
  region: string
  currency: string
  quantity: number
  price_native: number
  price_base: number
  value_base: number
  allocation_pct: number
  cost_basis_native: number
  cost_basis_base: number
  cost_total_base: number
  unrealized_pnl: number
  unrealized_pnl_pct: number | null
  day_change_pct: number | null
  acquired: string
  /** Trailing 90 trading days of price in base currency, for the row sparkline. */
  sparkline: number[]
  /**
   * The unrealised P&L split into the instrument's own price move and the
   * move of the currency it is quoted in. `null` when the position predates
   * the price history, so no entry price exists to compare against.
   */
  price_effect: number | null
  fx_effect: number | null
  /** Base-currency units per unit of the quote currency, now and at entry. */
  fx_rate_now: number
  fx_rate_at_acquisition: number
  price_native_at_acquisition: number | null
}

export interface HoldingsPayload extends Envelope {
  total_value: number
  holdings: Holding[]
}

/** Named performance windows shared by the summary and the performance readout. */
export type PeriodKey = 'day' | 'week' | 'month' | 'ytd' | 'all'

export interface PeriodChange {
  period: PeriodKey
  start_date: string
  start_value: number
  end_value: number
  absolute: number
  pct: number | null
  /** External contributions inside the window; excluded from `absolute`. */
  flows: number
}

export interface AllocationBucket {
  key: string
  value: number
  allocation_pct: number
  holdings: number
}

export interface SummaryPayload extends Envelope {
  total_value: number
  total_cost: number
  total_unrealized_pnl: number
  total_unrealized_pnl_pct: number | null
  holdings_count: number
  changes: Record<PeriodKey, PeriodChange>
  allocation_by_class: AllocationBucket[]
  allocation_by_region: AllocationBucket[]
  allocation_by_currency: AllocationBucket[]
  /** Unrealised P&L split into price effect and currency effect. */
  fx_attribution: {
    price_effect: number
    fx_effect: number
    /** P&L of positions acquired before the price history starts. */
    unattributed: number
    total: number
  }
  sparkline: {
    dates: string[]
    values: number[]
  }
}

/**
 * History is returned as parallel arrays sharing one `dates` array - materially
 * smaller than repeating a date per point across twelve per-holding series.
 *
 * `portfolio` is the time-weighted growth index scaled to today's value;
 * `portfolio_value` is the actual market value, including contribution jumps.
 */
export interface HistoryPayload extends Envelope {
  benchmark: string
  benchmark_name: string
  methodology: string
  dates: string[]
  portfolio: number[]
  portfolio_value: number[]
  benchmark_rebased: number[]
  drawdown_pct: number[]
  per_holding: Record<string, number[]>
  flows: { date: string; amount: number }[]
}

export interface MonthlyReturn {
  month: string
  pct: number | null
}

export interface YearlyReturn {
  year: string
  pct: number | null
}

export interface DayExtreme {
  date: string
  pct: number | null
}

export interface ReturnHistogramBin {
  start: number
  end: number
  count: number
}

export interface ReturnsPayload extends Envelope {
  methodology: string
  dates: string[]
  daily_pct: number[]
  cumulative_pct: number[]
  monthly_pct: MonthlyReturn[]
  yearly_pct: YearlyReturn[]
  histogram: ReturnHistogramBin[]
  observations: number
  best_day: DayExtreme
  worst_day: DayExtreme
  positive_days: number
  negative_days: number
  hit_rate_pct: number | null
  average_gain_pct: number | null
  average_loss_pct: number | null
  annualized_return_pct: number | null
  best_month_pct: number | null
  worst_month_pct: number | null
}

export interface MaxDrawdown {
  pct: number | null
  peak_date: string | null
  trough_date: string | null
  peak_value: number | null
  trough_value: number | null
  recovery_date: string | null
}

export interface ValueAtRisk {
  confidence: number
  historical_pct: number | null
  parametric_pct: number | null
  historical_value: number | null
  parametric_value: number | null
  cvar_pct: number | null
  cvar_value: number | null
}

export interface BenchmarkStats {
  name: string
  symbol: string
  /** True when the benchmark is a total-return series (dividends included). */
  includes_dividends: boolean
  correlation: number | null
  alpha_annualized_pct: number | null
  tracking_error_pct: number | null
  information_ratio: number | null
  up_capture: number | null
  down_capture: number | null
  max_drawdown_pct: number | null
  return_pct: number | null
  annualized_return_pct: number | null
  volatility_annualized_pct: number | null
  sharpe_ratio: number | null
  observations: number
}

export interface RiskContribution {
  ticker: string
  weight: number
  contribution_pct: number
}

export interface Concentration {
  herfindahl: number | null
  effective_holdings: number | null
  top_five_pct: number | null
  largest_pct: number | null
}

export interface RiskPayload extends Envelope {
  lookback_days: number
  risk_free_rate: number
  trading_days_per_year: number
  annualized_return_pct: number | null
  volatility_annualized_pct: number | null
  downside_deviation_pct: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  calmar_ratio: number | null
  max_drawdown: MaxDrawdown
  /** Keyed by confidence level as a whole-number string: "95", "99". */
  value_at_risk: Record<string, ValueAtRisk>
  beta: {
    value: number | null
    benchmark: string
    benchmark_name: string
  }
  benchmark: BenchmarkStats
  concentration: Concentration
  risk_contribution: RiskContribution[]
  correlation: {
    tickers: string[]
    matrix: (number | null)[][]
  }
  warnings: string[]
}

export interface HistogramBin {
  start: number
  end: number
  count: number
  probability: number
}

export interface MonteCarloPayload extends Envelope {
  paths: number
  horizon_days: number
  start_value: number
  /** One entry per simulated day, including day 0 (== `as_of`). */
  dates: string[]
  percentile_bands: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', number[]>
  final_values: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', number>
  histogram: HistogramBin[]
  expected_value: number
  median_value: number
  probability_below_start_pct: number
  expected_return_pct: number
  annualized_drift_pct: number
  assumptions: {
    distribution: string
    correlation: string
    rebalancing: string
    lookback_days: number
    fees: string
  }
}

/** Every analytic payload the dashboard needs, loaded together. */
export interface Analytics {
  health: Health
  holdings: HoldingsPayload
  summary: SummaryPayload
  history: HistoryPayload
  returns: ReturnsPayload
  risk: RiskPayload
  montecarlo: MonteCarloPayload
}

/** Shape of the committed `snapshot.json`. */
export interface Snapshot {
  generated_at: string
  as_of: string
  base_currency: string
  source?: string
  endpoints: {
    '/health': Health
    '/holdings': HoldingsPayload
    '/portfolio/summary': SummaryPayload
    '/portfolio/history': HistoryPayload
    '/portfolio/returns': ReturnsPayload
    '/portfolio/risk': RiskPayload
    '/portfolio/montecarlo': MonteCarloPayload
  }
}

/** A stored position, as returned by the CRUD API (not priced). */
export interface Position {
  id: number
  ticker: string
  name: string
  asset_class: string
  region: string | null
  currency: string
  quantity: number
  cost_basis_per_unit: number
  acquired: string
  created_at: string
  updated_at: string
}

/** The editable subset submitted by the portfolio editor. */
export interface PositionInput {
  ticker: string
  name: string
  asset_class: string
  region: string | null
  currency: string
  quantity: number
  cost_basis_per_unit: number
  acquired: string
}

export interface InstrumentInfo {
  ticker: string
  name: string
  currency: string
  asset_class: string
  region: string | null
  last_price: number | null
  as_of: string | null
  estimated: boolean
}

export interface SettingsInfo {
  benchmark: string
  benchmark_name: string
  /** True when the benchmark is a total-return series (dividends included). */
  benchmark_includes_dividends: boolean
  risk_free_rate: number
  history_years: number
  trading_days_per_year: number
  api_key_required: boolean
  seed_demo: boolean
}

/** An external contribution to, or withdrawal from, the portfolio. */
export interface CashFlow {
  id: number
  occurred_on: string
  amount: number
  note: string
  created_at?: string
}

/** Live API bootstrap payload. */
export interface BootstrapResponse {
  api_version: string
  source: 'api'
  base_currency: string
  positions: Position[]
  cash_flows: CashFlow[]
  analytics: Analytics | null
  warnings: string[]
  error: string | null
  settings: SettingsInfo
}

/** Normalised application state, identical for snapshot and API modes. */
export interface PortfolioState {
  source: DataSource
  apiVersion: string
  baseCurrency: string
  analytics: Analytics | null
  positions: Position[]
  cashFlows: CashFlow[]
  settings: SettingsInfo | null
  warnings: string[]
  error: string | null
  editable: boolean
}

export type DataSource = 'snapshot' | 'api'
