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
  /** True when the prices are older than the cache allows (provider down). */
  prices_stale: boolean
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
  /** What the owner wants to hold, as a fraction of the portfolio. */
  target_weight: number | null
  /** Current weight minus target weight; null without a target. */
  drift: number | null
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
  /** How far the portfolio has drifted from its target weights. */
  drift: {
    has_targets: boolean
    positions: {
      ticker: string
      current_weight: number
      target_weight: number
      drift: number
      trade_value: number
    }[]
    total_drift: number
    turnover: number
    target_sum: number
    residual: number
  }
  /** Where the active return above the benchmark came from. */
  attribution: {
    positions: {
      ticker: string
      name: string
      region: string | null
      asset_class: string
      weight: number
      contribution_pct: number
    }[]
    by_region: { key: string; contribution_pct: number }[]
    by_asset_class: { key: string; contribution_pct: number }[]
    active_return_pct: number
    residual: number
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
  /** Annualised return on the money actually invested (IRR). */
  money_weighted_return_pct: number | null
  /** Whether the cash flows behind the IRR are recorded or estimated. */
  money_weighted_source: 'ledger' | 'estimated'
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
  /** Optional target weight as a fraction of the portfolio. */
  target_weight: number | null
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
  /** Optional target weight as a fraction of the portfolio. */
  target_weight?: number | null
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

/** A tracked portfolio. */
export interface Portfolio {
  id: number
  name: string
  base_currency: string
  created_at: string
}

/** An external contribution to, or withdrawal from, the portfolio. */
export interface CashFlow {
  id: number
  occurred_on: string
  amount: number
  note: string
  created_at?: string
}

export type OrderType = 'BUY' | 'SELL'

export interface Transaction {
  id: number
  portfolio_id: number
  ticker: string
  order_type: OrderType
  quantity: number
  price: number
  realized_pnl: number
  executed_at: string
  notes: string
  created_at: string
}

export interface OrderInput {
  ticker: string
  order_type: OrderType
  quantity: number
  price: number
  executed_at: string
  notes?: string
}

export interface RealizedPnlSummary {
  total_realized_pnl: number
  total_trades: number
  total_buys: number
  total_sells: number
  winning_trades: number
  losing_trades: number
  win_rate_pct: number | null
  total_buy_volume: number
  total_sell_volume: number
}

/** Live API bootstrap payload. */
export interface BootstrapResponse {
  api_version: string
  source: 'api'
  base_currency: string
  positions: Position[]
  cash_flows: CashFlow[]
  /** The portfolio this request was about. */
  portfolio_id: number
  portfolios: Portfolio[]
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
  portfolioId: number
  portfolios: Portfolio[]
  settings: SettingsInfo | null
  warnings: string[]
  error: string | null
  editable: boolean
}

export type DataSource = 'snapshot' | 'api'

// --------------------------------------------------------------------------
// Fixed Income & Yield Curve Types
// --------------------------------------------------------------------------

export interface YieldPoint {
  tenor: string
  series_id: string
  years: number
  yield_pct: number
}

export interface YieldCurveSnapshot {
  as_of_date: string
  curve_points: YieldPoint[]
  curve_points_1m_ago?: YieldPoint[] | null
  curve_points_1y_ago?: YieldPoint[] | null
  spread_10y_2y_bps: number
  spread_10y_3m_bps: number
  curve_status: 'NORMAL' | 'INVERTED' | 'FLAT' | string
  us10y_yield: number
  us2y_yield: number
  us3m_yield: number
  aaa_yield?: number | null
  baa_yield?: number | null
  credit_spread_baa_aaa_bps?: number | null
  credit_spread_baa_10y_bps?: number | null
}

export interface HistoricalYieldPoint {
  date: string
  dgs10?: number | null
  dgs2?: number | null
  dgs3mo?: number | null
  t10y2y?: number | null
  aaa?: number | null
  baa?: number | null
}

export interface BondCalculatorInput {
  face_value: number
  coupon_rate: number
  ytm: number
  years_to_maturity: number
  frequency: number
}

export interface RateShockScenario {
  shift_bps: number
  new_ytm: number
  repriced_bond: number
  price_change_dollars: number
  price_change_pct: number
}

export interface BondCalculatorOutput {
  price: number
  clean_price: number
  macaulay_duration: number
  modified_duration: number
  convexity: number
  dv01: number
  annual_coupon_income: number
  current_yield: number
  scenarios: RateShockScenario[]
}

// --------------------------------------------------------------------------
// Macroeconomic & SEC EDGAR Types
// --------------------------------------------------------------------------

export interface SecFilingItem {
  form: string
  filing_date: string
  report_date?: string | null
  accession_number: string
  primary_document: string
  description: string
  url: string
  is_xbrl: boolean
}

export interface SecFilingsResponse {
  ticker: string
  cik: string
  company_name: string
  filings: SecFilingItem[]
}

export interface MacroIndicator {
  series_id: string
  name: string
  category: string
  latest_value: number
  unit: string
  observation_date: string
  previous_value: number
  change: number
  change_pct: number
}

export interface MacroSummaryResponse {
  indicators: MacroIndicator[]
  as_of: string
}

export interface MacroHistoryPoint {
  date: string
  value: number
}

// --------------------------------------------------------------------------
// Options & Derivatives Types
// --------------------------------------------------------------------------

export interface OptionContract {
  contract_symbol: string
  strike: number
  last_price: number
  bid?: number | null
  ask?: number | null
  volume: number
  open_interest: number
  implied_volatility: number
  in_the_money: boolean
  delta?: number | null
  gamma?: number | null
  vega?: number | null
  theta?: number | null
}

export interface OptionChainResponse {
  ticker: string
  underlying_price: number
  expirations: string[]
  selected_expiration: string
  calls: OptionContract[]
  puts: OptionContract[]
}

export interface BlackScholesInput {
  underlying_price: number
  strike_price: number
  dte: number
  volatility_pct: number
  risk_free_rate_pct: number
  dividend_yield_pct: number
}

export interface OptionGreeks {
  delta: number
  gamma: number
  vega: number
  theta: number
  rho: number
}

export interface PayoffPoint {
  underlying_price: number
  call_payoff: number
  put_payoff: number
}

export interface BlackScholesOutput {
  call_price: number
  put_price: number
  call_greeks: OptionGreeks
  put_greeks: OptionGreeks
  call_intrinsic: number
  call_time_value: number
  put_intrinsic: number
  put_time_value: number
  payoff_curve: PayoffPoint[]
}

// --------------------------------------------------------------------------
// Portfolio Lab: Stress Testing, Brinson Attribution & Portfolio X-Ray
// --------------------------------------------------------------------------

export interface StressShock {
  equity_pct: number
  rates_bps: number
  usd_pct: number
  gold_pct: number
  crypto_pct: number
}

export interface StressBucketRow {
  key: string
  pnl: number
  pct_of_portfolio: number
}

export interface StressPositionRow {
  ticker: string
  name: string
  asset_class: string
  factor: string
  weight: number
  sensitivity: number
  price_move_pct: number
  fx_move_pct: number
  total_move_pct: number
  pnl: number
}

export interface StressScenarioResult {
  key: string
  name: string
  description: string
  window: string
  kind: 'historical' | 'parametric' | 'custom' | string
  shock: StressShock
  value_before: number
  value_after: number
  pnl: number
  pnl_pct: number
  fx_pnl: number
  by_factor: StressBucketRow[]
  by_asset_class: StressBucketRow[]
  positions: StressPositionRow[]
}

export interface StressReport {
  as_of: string
  base_currency: string
  total_value: number
  benchmark: string
  results: StressScenarioResult[]
  betas: Record<string, number>
  methodology: string
}

export type AttributionPeriod = 'day' | 'week' | 'month' | 'ytd' | 'all'
export type AttributionGroupBy = 'asset_class' | 'region' | 'currency'

export interface AttributionSegmentRow {
  key: string
  portfolio_weight: number
  benchmark_weight: number
  portfolio_return_pct: number
  benchmark_return_pct: number
  allocation_pct: number
  selection_pct: number
  interaction_pct: number
  total_pct: number
}

export interface AttributionTotals {
  portfolio_return_pct: number
  benchmark_return_pct: number
  active_return_pct: number
  allocation_pct: number
  selection_pct: number
  interaction_pct: number
  residual_pct: number
  weights_normalised: boolean
}

export interface AttributionReport {
  as_of: string
  period: AttributionPeriod
  group_by: AttributionGroupBy
  start_date: string
  end_date: string
  benchmark_mode: string
  benchmark_label: string
  excluded: string[]
  time_weighted_return_pct: number
  basis: string
  segments: AttributionSegmentRow[]
  totals: AttributionTotals
}

export interface XRayFinding {
  severity: 'high' | 'medium' | 'low'
  code: string
  message: string
}

export interface XRayExposureItem {
  key: string
  weight: number
}

export interface XRayRiskVsCapitalRow {
  ticker: string
  weight: number
  risk_share: number
  risk_to_weight: number
}

export interface XRayOverlapPair {
  a: string
  b: string
  correlation: number
}

export interface XRayOverlapCluster {
  tickers: string[]
  combined_weight: number
}

export interface XRayReport {
  as_of: string
  total_value: number
  positions: number
  headline: {
    effective_holdings: number
    herfindahl: number
    largest_pct: number
    top_five_pct: number
    diversification_ratio: number | null
  }
  findings: XRayFinding[]
  exposure: {
    asset_class: XRayExposureItem[]
    region: XRayExposureItem[]
    currency: XRayExposureItem[]
  }
  risk_vs_capital: XRayRiskVsCapitalRow[]
  overlap: {
    pairs: XRayOverlapPair[]
    clusters: XRayOverlapCluster[]
    threshold: number
  }
  methodology: string
}

export interface FactsheetHoldingRow {
  ticker: string
  name: string
  asset_class: string
  region: string | null
  currency: string
  weight: number
  value_base: number
  unrealized_pnl: number
  unrealized_pnl_pct: number
}

export interface FactsheetStressHighlight {
  key: string
  name: string
  window: string
  pnl: number
  pnl_pct: number
  value_after: number
}

export interface FactsheetReport {
  as_of: string
  generated_at: string | null
  portfolio_name: string
  base_currency: string
  benchmark: string
  kpis: {
    total_value: number
    total_cost: number
    unrealized_pnl: number
    unrealized_pnl_pct: number
    realized_pnl: number
    win_rate_pct: number | null
    twr_pct: number
    mwr_pct: number | null
    benchmark_return_pct: number
    active_return_pct: number
    annualized_vol_pct: number | null
    sharpe: number | null
    sortino: number | null
    max_drawdown_pct: number | null
    var_95_pct: number | null
    cvar_95_pct: number | null
    effective_holdings: number
    top_five_pct: number
    diversification_ratio: number | null
  }
  narrative: {
    mandate_overview: string
    performance_drivers: string
    risk_and_concentration: string
    stress_resilience: string
  }
  top_holdings: FactsheetHoldingRow[]
  xray_findings: XRayFinding[]
  exposure: {
    asset_class: XRayExposureItem[]
    region: XRayExposureItem[]
    currency: XRayExposureItem[]
  }
  attribution_totals: AttributionTotals
  attribution_segments: AttributionSegmentRow[]
  stress_highlights: FactsheetStressHighlight[]
  markdown_memo: string
}


